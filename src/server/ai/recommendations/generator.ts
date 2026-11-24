/**
 * Recommendation generation for one JobRun (kind RECOMMENDATIONS) created by
 * recommendation.generate.
 *
 * Input: the top themes of a READY synthesis in the same project, each with
 * verified citations. Themes are labelled with server-assigned refs ("T1"); the
 * model's themeRefs are validated and every quote in a recommendation's
 * evidence is taken from stored citations, never from model output.
 *
 * Idempotent: the run's previous recommendations (runId = jobRunId) are
 * replaced in one transaction, so a retry never duplicates.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { emitEvent } from "@/server/events/bus";
import { failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { generateObject } from "../client";
import { untrusted } from "../untrusted";
import { FEATURES, RECOMMENDATIONS_SYSTEM } from "../prompts";
import type { EvidenceQuote, RecommendationEvidence, SynthesisOutput } from "../types";
import { clamp, round, truncate } from "../utils";
import { computeLearningSummary, learningContextFromSummary, scoreAdjustment } from "../outcomes/learning-engine";

const MAX_THEMES = 25;
const QUOTES_PER_THEME = 4;
const MAX_RECOMMENDATIONS = 8;
const MAX_EVIDENCE_QUOTES = 8;

export const recommendationsSchema = z.object({
  recommendations: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      impact: z.enum(["HIGH", "MEDIUM", "LOW"]),
      confidence: z.number(),
      segments: z.array(z.string()),
      themeRefs: z.array(z.string()),
      rationale: z.string(),
    })
  ),
});

export interface RecommendationJob {
  jobRunId: string;
  projectId: string;
  synthesisId: string | null;
}

interface LoadedTheme {
  ref: string;
  id: string;
  name: string;
  description: string;
  sentiment: string;
  confidenceScore: number;
  frequency: number | null;
  severity: string | null;
  quotes: EvidenceQuote[];
}

async function loadThemes(synthesisId: string): Promise<LoadedTheme[]> {
  const [synthesis, themes] = await Promise.all([
    prisma.synthesis.findUnique({ where: { id: synthesisId }, select: { output: true } }),
    prisma.theme.findMany({
      where: { synthesisId },
      orderBy: { confidenceScore: "desc" },
      take: MAX_THEMES,
      select: {
        id: true,
        name: true,
        description: true,
        sentiment: true,
        confidenceScore: true,
        citations: {
          orderBy: { relevanceScore: "desc" },
          take: QUOTES_PER_THEME,
          select: { quote: true, chunk: { select: { id: true, position: true, documentId: true, document: { select: { title: true } } } } },
        },
      },
    }),
  ]);
  const stats = new Map(((synthesis?.output as unknown as SynthesisOutput | null)?.themes ?? []).map((s) => [s.themeId, s]));
  return themes.map((t, i) => ({
    ref: `T${i + 1}`,
    id: t.id,
    name: t.name,
    description: t.description,
    sentiment: t.sentiment,
    confidenceScore: t.confidenceScore,
    frequency: stats.get(t.id)?.frequency ?? null,
    severity: stats.get(t.id)?.severity ?? null,
    quotes: t.citations.map((c) => ({
      chunkId: c.chunk.id,
      documentId: c.chunk.documentId,
      documentTitle: c.chunk.document.title,
      quote: c.quote,
      position: c.chunk.position,
    })),
  }));
}

function themeBlock(t: LoadedTheme): string {
  const facts = [
    `sentiment ${t.sentiment.toLowerCase()}`,
    `confidence ${t.confidenceScore.toFixed(2)}`,
    t.frequency !== null ? `${t.frequency} supporting document${t.frequency === 1 ? "" : "s"}` : null,
    t.severity ? `severity ${t.severity}` : null,
  ].filter(Boolean);
  const quotes = t.quotes.map((q) => `- "${truncate(q.quote, 300)}"`).join("\n");
  return untrusted(`theme:${t.ref}`, `${t.ref}: ${t.name} (${facts.join(", ")})\n${t.description}${quotes ? `\nCustomer quotes:\n${quotes}` : ""}`);
}

export async function runRecommendations(job: RecommendationJob, log: Logger): Promise<{ created: number } | null> {
  const run = await prisma.jobRun.findUnique({
    where: { id: job.jobRunId },
    select: { id: true, kind: true, status: true, orgId: true, projectId: true, createdById: true, output: true },
  });
  if (!run || run.kind !== "RECOMMENDATIONS" || run.projectId !== job.projectId) {
    log.warn("recommendation run not found or mismatched; skipping", { jobRunId: job.jobRunId });
    return null;
  }
  if (run.status === "READY") {
    return { created: await prisma.recommendation.count({ where: { runId: run.id } }) };
  }

  await prisma.jobRun.update({
    where: { id: run.id },
    data: { status: "PROCESSING", startedAt: new Date(), errorMessage: null, completedAt: null },
  });

  const synthesis = job.synthesisId
    ? await prisma.synthesis.findFirst({ where: { id: job.synthesisId, projectId: job.projectId, status: "READY" }, select: { id: true } })
    : await prisma.synthesis.findFirst({
        where: { projectId: job.projectId, status: "READY" },
        orderBy: { completedAt: "desc" },
        select: { id: true },
      });
  if (!synthesis) throw new NonRetryableError("The synthesis for these recommendations is no longer available");

  const themes = await loadThemes(synthesis.id);
  if (themes.length === 0) throw new NonRetryableError("The synthesis has no themes to base recommendations on");
  const byRef = new Map(themes.map((t) => [t.ref, t]));

  // Continuous learning: how this project's past recommendations
  // performed once shipped. Computed in code from outcome tracking, so it is
  // trusted context (no customer text).
  const learning = await computeLearningSummary(job.projectId);
  const learningContext = learningContextFromSummary(learning);

  const out = await generateObject({
    feature: FEATURES.recommendationsGenerate,
    orgId: run.orgId,
    projectId: job.projectId,
    system: RECOMMENDATIONS_SYSTEM,
    prompt:
      `Themes from the latest research synthesis (${themes.length}):\n\n${themes.map(themeBlock).join("\n\n")}` +
      (learningContext ? `\n\nOutcomes of this project's previously shipped recommendations:\n${learningContext}` : ""),
    schema: recommendationsSchema,
    effort: "high",
    maxTokens: 16_000,
  });

  const items = out.recommendations
    .map((r) => {
      const refs = [...new Set(r.themeRefs.map((x) => x.trim().toUpperCase()))].filter((x) => byRef.has(x));
      const supporting = refs.map((x) => byRef.get(x)!);
      if (supporting.length === 0 || !r.title.trim()) return null;
      const quotes: EvidenceQuote[] = [];
      for (const t of supporting) for (const q of t.quotes) if (quotes.length < MAX_EVIDENCE_QUOTES) quotes.push(q);
      const modelConfidence = round(clamp(r.confidence, 0, 1), 2);
      const themeConfidence = supporting.reduce((s, t) => s + t.confidenceScore, 0) / supporting.length;
      const evidence: RecommendationEvidence = {
        themes: supporting.map((t) => ({ id: t.id, name: t.name })),
        quotes,
        rationale: truncate(r.rationale.trim(), 1_500),
        modelConfidence,
      };
      return {
        title: truncate(r.title.trim(), 200),
        description: truncate(r.description.trim(), 4_000),
        impact: r.impact,
        // Blend the model's judgement with how well-supported the themes are,
        // then adjust by how similar recommendations performed when shipped
        // (a bounded 0.8–1.2 multiplier; 1 until enough outcomes are measured).
        confidence: (() => {
          const base = clamp(0.5 * modelConfidence + 0.5 * themeConfidence, 0, 1);
          return round(clamp(base * scoreAdjustment(learning, { impact: r.impact, confidence: base }), 0, 1), 2);
        })(),
        segments: [...new Set(r.segments.map((s) => truncate(s.trim(), 60)).filter(Boolean))].slice(0, 5),
        evidence,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, MAX_RECOMMENDATIONS);

  if (items.length === 0) throw new NonRetryableError("No recommendations could be grounded in the synthesis themes");

  const created = await prisma.$transaction(async (tx) => {
    await tx.recommendation.deleteMany({ where: { runId: run.id, projectId: job.projectId } });
    const rows = await tx.recommendation.createManyAndReturn({
      data: items.map((i) => ({
        projectId: job.projectId,
        synthesisId: synthesis.id,
        runId: run.id,
        title: i.title,
        description: i.description,
        impact: i.impact,
        confidence: i.confidence,
        segments: i.segments,
        evidence: i.evidence as unknown as Prisma.InputJsonValue,
        status: "DRAFT" as const,
      })),
      select: { id: true, title: true, impact: true, confidence: true },
    });
    await tx.jobRun.update({
      where: { id: run.id },
      data: {
        status: "READY",
        completedAt: new Date(),
        output: { synthesisId: synthesis.id, recommendationIds: rows.map((r) => r.id), count: rows.length },
      },
    });
    return rows;
  });

  for (const r of created) {
    await emitEvent({
      orgId: run.orgId,
      projectId: job.projectId,
      type: "recommendation.created",
      payload: { recommendationId: r.id, title: r.title, impact: r.impact, confidence: r.confidence },
      actorUserId: run.createdById,
    });
  }
  log.info("recommendations generated", { jobRunId: run.id, count: created.length });
  return { created: created.length };
}

export async function markRecommendationsFailed(jobRunId: string, err: Error): Promise<void> {
  await prisma.jobRun.updateMany({
    where: { id: jobRunId, kind: "RECOMMENDATIONS", status: { not: "READY" } },
    data: { status: "FAILED", errorMessage: failureMessage(err), completedAt: new Date() },
  });
}
