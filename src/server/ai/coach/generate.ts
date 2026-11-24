/**
 * Coaching run (QUEUE.COACHING). Builds a bounded context from the project's
 * data, asks the model for a few specific PM coaching insights, drops ones
 * that repeat a recipient's recent insights, and stores them (plus a
 * CoachSession for the history view). Runs only in the worker, never inline in
 * a request. Retry-safe: rows written by an earlier attempt of the same run
 * are replaced, and a READY run is not run again.
 */
import { CoachInsightPriority, CoachInsightType, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { NonRetryableError } from "../../jobs/worker";
import { getMembership } from "../../auth/access";
import { generateObject } from "../client";
import { UNTRUSTED_DATA_POLICY, untrusted } from "../untrusted";
import { recentActors } from "./activity";
import { buildCoachContext, type CoachContext } from "./context";

export const COACH_FEATURE = "coach.insights";
const MAX_INSIGHTS = 5;
const MAX_RECIPIENTS = 5;
const DEDUPE_DAYS = 21;
const ACTOR_WINDOW_MS = 14 * 86_400_000;

const runInputSchema = z.object({ trigger: z.enum(["manual", "event", "digest"]).catch("manual"), eventType: z.string().optional() }).catch({ trigger: "manual" });

const schema = z.object({
  summary: z.string().describe("Two sentences on the state of this project's product practice"),
  insights: z.array(
    z.object({
      type: z.enum(CoachInsightType),
      priority: z.enum(CoachInsightPriority),
      title: z.string().describe("Specific, under 90 characters"),
      message: z.string().describe("2-4 sentences: what you noticed and why it matters"),
      rationale: z.string().describe("The concrete facts from the context that support this insight"),
      actionItems: z.array(z.string()).describe("1-3 concrete next steps"),
      framework: z.string().nullable().describe("PM framework that applies (e.g. RICE, JTBD, Kano, OKRs), or null"),
    })
  ),
});

const SYSTEM = `You are an experienced product-management coach reviewing one product team's work in Beacon, a tool that turns customer feedback into themes, recommendations and decisions.
From the facts provided, give at most ${MAX_INSIGHTS} specific, actionable coaching insights. Prefer fewer, sharper insights over generic advice.
Ground each insight in the facts given (cite numbers and theme names). Do not invent facts. Skip anything already going well unless it is worth reinforcing.
Types: FRAMEWORK_SUGGESTION, PROCESS_IMPROVEMENT, BEST_PRACTICE, WARNING (risk the team should act on), NUDGE (small next step).

${UNTRUSTED_DATA_POLICY}`;

function factsPrompt(c: CoachContext): string {
  const p = c.decisionPatterns;
  const facts = [
    `Window: last 30 days (as of ${c.generatedAt.toISOString().slice(0, 10)}).`,
    `Documents: ${c.counts.documents} total, ${c.counts.documentsRecent} added recently, ${c.counts.documentsFailed} failed processing recently.`,
    `Syntheses completed recently: ${c.counts.synthesesRecent}; latest synthesis: ${c.latestSynthesisAt ? c.latestSynthesisAt.toISOString().slice(0, 10) : "never"}.`,
    `Questions asked recently: ${c.counts.queriesRecent}.`,
    `Recommendations: ${p.drafts} draft, ${p.accepted} accepted, ${p.implemented} implemented, ${p.rejected} rejected; ${c.counts.recommendationsRecent} created recently; ${c.counts.staleDrafts} drafts older than 14 days.`,
    `Acceptance rate: ${p.acceptanceRate ?? "n/a"}; average confidence of accepted ${p.avgConfidenceAccepted ?? "n/a"} vs rejected ${p.avgConfidenceRejected ?? "n/a"}.`,
    `Accepted/implemented recommendations without outcome tracking: ${c.counts.acceptedWithoutOutcome}; outcomes tracked: ${c.counts.outcomesTracked}.`,
    `Decisions logged: ${p.decisionsLogged}; share citing evidence: ${p.decisionsWithEvidenceShare ?? "n/a"}.`,
    `Open sentiment alerts: ${c.counts.openSentimentAlerts}; latest sentiment: ${c.sentiment ? `${c.sentiment.overallScore.toFixed(2)} (${c.sentiment.riskLevel}, ${c.sentiment.period})` : "none"}.`,
    `Knowledge-graph entities linked to this project: ${c.counts.knowledgeEntities}.`,
    `Recent activity events (14 days): ${Object.entries(c.activity).map(([k, v]) => `${k} ${v}`).join(", ") || "none recorded"}.`,
  ];
  const themes = c.themes
    .slice(0, 12)
    .map((t) => `- ${t.name} [${t.sentiment}, confidence ${t.confidenceScore.toFixed(2)}, ${t.citationCount} citations]${t.sampleQuotes[0] ? `: "${t.sampleQuotes[0].slice(0, 200)}"` : ""}`)
    .join("\n");
  const ignored = c.ignoredThemes.map((t) => `- ${t.name} (${t.citationCount} citations, ${t.sentiment})`).join("\n");
  const recs = c.recentRecommendations.map((r) => `- [${r.status}, ${r.impact}, confidence ${r.confidence.toFixed(2)}] ${r.title}`).join("\n");
  const decisions = c.recentDecisions.map((d) => `- ${d.decision}${d.hasEvidence ? "" : " (no evidence linked)"}`).join("\n");
  return [
    "Computed facts:",
    facts.join("\n"),
    "Project:",
    untrusted("project", `${c.project.name}${c.project.description ? `\n${c.project.description.slice(0, 500)}` : ""}`),
    "Latest themes from customer feedback:",
    untrusted("themes", themes || "(none)"),
    "Well-supported themes no recommendation appears to address:",
    untrusted("ignored-themes", ignored || "(none)"),
    "Recent recommendations:",
    untrusted("recommendations", recs || "(none)"),
    "Recent decisions:",
    untrusted("decisions", decisions || "(none)"),
  ].join("\n\n");
}

const titleTokens = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/** True when `title` repeats one of `previous` (same words, or ≥ 60% Jaccard overlap). */
export function isDuplicateTitle(title: string, previous: string[]): boolean {
  const a = titleTokens(title);
  if (a.size === 0) return true;
  return previous.some((p) => {
    const b = titleTokens(p);
    if (b.size === 0) return false;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter) >= 0.6;
  });
}

async function recipientsFor(run: { createdById: string | null }, project: CoachContext["project"]): Promise<string[]> {
  if (run.createdById) {
    const m = await getMembership(prisma, run.createdById, project.orgId);
    return m && m.role !== "VIEWER" ? [run.createdById] : [];
  }
  const candidates = [...new Set([...(await recentActors(project.id, ACTOR_WINDOW_MS, 10)), project.userId])];
  const members = await prisma.orgMember.findMany({
    where: { orgId: project.orgId, userId: { in: candidates }, joinedAt: { not: null }, role: { in: ["OWNER", "ADMIN", "MEMBER"] } },
    select: { userId: true },
  });
  const ok = new Set(members.map((m) => m.userId));
  return candidates.filter((id) => ok.has(id)).slice(0, MAX_RECIPIENTS);
}

interface DraftInsight {
  type: CoachInsightType;
  priority: CoachInsightPriority;
  title: string;
  message: string;
  rationale: string | null;
  actionItems: string[];
  framework: string | null;
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

export interface CoachingOutput {
  insightsCreated: number;
  recipients: number;
  skippedDuplicates: number;
  summary: string | null;
  trigger: string;
}

export async function runCoaching(jobRunId: string, log: Logger): Promise<CoachingOutput> {
  const run = await prisma.jobRun.findFirst({
    where: { id: jobRunId, kind: "COACHING" },
    select: { id: true, status: true, projectId: true, createdById: true, input: true, output: true },
  });
  if (!run) throw new NonRetryableError("Coaching job not found");
  if (run.status === "READY" && run.output) return run.output as unknown as CoachingOutput;
  if (!run.projectId) throw new NonRetryableError("Coaching requires a project");
  const { trigger } = runInputSchema.parse(run.input ?? {});

  await prisma.jobRun.update({ where: { id: run.id }, data: { status: "PROCESSING", startedAt: new Date(), errorMessage: null } });

  const context = await buildCoachContext(run.projectId);
  if (!context) throw new NonRetryableError("Project not found");
  const recipients = await recipientsFor(run, context.project);

  let summary: string | null = null;
  let drafts: DraftInsight[] = [];
  if (recipients.length > 0) {
    if (context.counts.documents === 0) {
      // Nothing to analyze yet: a fixed onboarding nudge, no model call.
      drafts = [
        {
          type: "NUDGE",
          priority: "MEDIUM",
          title: "Add customer feedback to get started",
          message: "This project has no feedback yet. Upload interview notes, support tickets or call transcripts, or connect an integration, so Beacon can surface themes and the coach can review your decisions.",
          rationale: "The project has 0 documents.",
          actionItems: ["Upload a few recent customer interviews or tickets", "Connect a feedback source under Integrations"],
          framework: null,
        },
      ];
    } else {
      const raw = await generateObject({
        feature: COACH_FEATURE,
        orgId: context.project.orgId,
        projectId: context.project.id,
        system: SYSTEM,
        prompt: factsPrompt(context),
        schema,
        maxTokens: 6_000,
        effort: "medium",
      });
      summary = clean(raw.summary, 600) || null;
      const seen: string[] = [];
      for (const i of raw.insights) {
        const title = clean(i.title, 120);
        const message = clean(i.message, 1_500);
        if (!title || !message || isDuplicateTitle(title, seen)) continue;
        seen.push(title);
        drafts.push({
          type: i.type,
          priority: i.priority,
          title,
          message,
          rationale: clean(i.rationale, 800) || null,
          actionItems: i.actionItems.map((a) => clean(a, 200)).filter(Boolean).slice(0, 3),
          framework: i.framework ? clean(i.framework, 60) || null : null,
        });
        if (drafts.length >= MAX_INSIGHTS) break;
      }
    }
  }

  const since = new Date(Date.now() - DEDUPE_DAYS * 86_400_000);
  const output = await prisma.$transaction(async (tx) => {
    // Replace anything an earlier attempt of this run wrote.
    await tx.coachInsight.deleteMany({ where: { evidence: { path: ["jobRunId"], equals: run.id } } });
    await tx.coachSession.deleteMany({ where: { context: { path: ["jobRunId"], equals: run.id } } });

    let created = 0;
    let skipped = 0;
    for (const userId of recipients) {
      const recent = await tx.coachInsight.findMany({
        where: { userId, projectId: context.project.id, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 100,
        select: { title: true },
      });
      const previous = recent.map((r) => r.title);
      const fresh = drafts.filter((d) => {
        if (isDuplicateTitle(d.title, previous)) {
          skipped++;
          return false;
        }
        return true;
      });
      if (fresh.length > 0) {
        await tx.coachInsight.createMany({
          data: fresh.map((d) => ({
            userId,
            projectId: context.project.id,
            type: d.type,
            priority: d.priority,
            title: d.title,
            message: d.message,
            evidence: {
              jobRunId: run.id,
              trigger,
              rationale: d.rationale,
              actionItems: d.actionItems,
              framework: d.framework,
            } satisfies Prisma.InputJsonValue,
          })),
        });
        created += fresh.length;
      }
      await tx.coachSession.create({
        data: {
          userId,
          context: {
            jobRunId: run.id,
            projectId: context.project.id,
            trigger,
            summary,
            ignoredThemes: context.ignoredThemes.map((t) => t.name),
            staleDrafts: context.counts.staleDrafts,
            acceptedWithoutOutcome: context.counts.acceptedWithoutOutcome,
          } satisfies Prisma.InputJsonValue,
          recommendations: fresh.map((d) => ({ title: d.title, type: d.type, priority: d.priority })) satisfies Prisma.InputJsonValue,
        },
      });
    }
    const out: CoachingOutput = { insightsCreated: created, recipients: recipients.length, skippedDuplicates: skipped, summary, trigger };
    await tx.jobRun.update({
      where: { id: run.id },
      data: { status: "READY", output: out as unknown as Prisma.InputJsonValue, completedAt: new Date(), errorMessage: null },
    });
    return out;
  });
  log.info("coaching run complete", { jobRunId: run.id, ...output, summary: undefined });
  return output;
}
