import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { runJob } from "@/server/jobs/worker";
import { LLMError, type GenerateObjectRequest } from "@/server/ai/client";
import { sentimentWorker } from "@/workers/sentiment-worker";
import { runSentimentAnalysis } from "@/server/ai/sentiment/run";
import { lastCompleteWindow, periodStartFor, windowFor } from "@/server/ai/sentiment/periods";
import { detectAnomalies } from "@/server/ai/sentiment/anomalies";
import { aggregate } from "@/server/ai/sentiment/aggregate";
import { identityFromMetadata } from "@/server/ai/sentiment/customers";
import { run as scheduleSentiment } from "@/server/schedules/sentiment";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { chunksInPrompt, documentWithChunks, expectTRPCCode, insightsCaller, testLog } from "./helpers";

type Req = GenerateObjectRequest<z.ZodType>;

/** Classifier fake: sentiment from keywords in each chunk; records what it was shown. */
function scriptClassifier(seen: string[] = []) {
  scriptLLM("sentiment.classify", (req: Req) => {
    const chunks = chunksInPrompt(req.prompt);
    return {
      items: chunks.map((c) => {
        seen.push(c.text);
        const negative = /hate|broken|cancel|slow/i.test(c.text);
        const positive = /love|great/i.test(c.text);
        return {
          ref: c.label,
          sentiment: negative ? "NEGATIVE" : positive ? "POSITIVE" : "NEUTRAL",
          score: negative ? -0.8 : positive ? 0.8 : 0,
          themes: negative ? ["Performance"] : ["Onboarding"],
          customer: null,
          churnSignals: /cancel/i.test(c.text) ? ["Plans to cancel at renewal"] : [],
        };
      }),
    };
  });
}

function scriptChurn() {
  scriptLLM("sentiment.churn", (req: Req) => {
    const refs = [...req.prompt.matchAll(/^A(\d+): /gm)].map((m) => `A${m[1]}`);
    return {
      assessments: refs.map((ref) => ({
        ref,
        riskScore: 0.82,
        riskLevel: "HIGH",
        signals: [{ label: "Cancellation intent", evidence: "cancel at renewal", weight: "HIGH" }, { label: "Invented", evidence: "this quote is not in the feedback", weight: "LOW" }],
        recommendations: ["Schedule an executive call"],
        confidence: 0.7,
      })),
    };
  });
}

async function fixture() {
  const owner = await createUser();
  const org = await createOrg(owner);
  const project = await createProject(owner, org.id);
  return { owner, org, project };
}

const WEEK = lastCompleteWindow("WEEKLY", new Date());
const inWindow = (offsetHours = 30) => new Date(WEEK.start.getTime() + offsetHours * 3600_000);

describe("sentiment periods", () => {
  it("computes UTC windows", () => {
    const at = new Date("2026-11-26T15:00:00Z"); // Thursday
    expect(periodStartFor("DAILY", at).toISOString()).toBe("2026-11-26T00:00:00.000Z");
    expect(periodStartFor("WEEKLY", at).toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(periodStartFor("MONTHLY", at).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(windowFor("MONTHLY", at).end.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(lastCompleteWindow("WEEKLY", at)).toMatchObject({ start: new Date("2026-11-16T00:00:00Z"), end: new Date("2026-11-23T00:00:00Z") });
  });
});

describe("sentiment worker", () => {
  it("analyzes only chunks of documents created inside the period window", async () => {
    const { project } = await fixture();
    await documentWithChunks(project.id, { chunks: ["I love the new editor", "The importer is broken"], createdAt: inWindow() });
    await documentWithChunks(project.id, { chunks: ["Old feedback: dashboards are slow"], createdAt: new Date(WEEK.start.getTime() - 3600_000) });
    await documentWithChunks(project.id, { chunks: ["Newer feedback: great support"], createdAt: new Date(WEEK.end.getTime() + 3600_000) });
    const seen: string[] = [];
    scriptClassifier(seen);

    const out = await runSentimentAnalysis({ projectId: project.id, period: "WEEKLY", periodStart: WEEK.start.toISOString() }, testLog);
    expect(seen.sort()).toEqual(["I love the new editor", "The importer is broken"]);
    expect(out).toMatchObject({ status: "analyzed", totalChunks: 2, sampledChunks: 2, classifiedChunks: 2, volume: 2 });
    const snaps = await prisma.sentimentSnapshot.findMany({ where: { projectId: project.id } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ customerSegment: "all", period: "WEEKLY", volume: 2, positiveCount: 1, negativeCount: 1, periodStart: WEEK.start, periodEnd: WEEK.end });
  });

  it("upserts the snapshot on its unique key when re-run", async () => {
    const { project } = await fixture();
    await documentWithChunks(project.id, { chunks: ["I love it", "It is broken"], createdAt: inWindow() });
    scriptClassifier();
    const input = { projectId: project.id, period: "WEEKLY" as const, periodStart: WEEK.start.toISOString() };
    await runSentimentAnalysis(input, testLog);
    await documentWithChunks(project.id, { chunks: ["Great release"], createdAt: inWindow(40) });
    await runSentimentAnalysis(input, testLog);
    const snaps = await prisma.sentimentSnapshot.findMany({ where: { projectId: project.id, customerSegment: "all" } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0].volume).toBe(3);
  });

  it("fails the run (no zero-volume snapshot) when every classification fails", async () => {
    const { owner, org, project } = await fixture();
    await documentWithChunks(project.id, { chunks: ["Something", "Something else"], createdAt: inWindow() });
    scriptLLM("sentiment.classify", () => {
      throw new LLMError("The model declined this request (sentiment.classify)", "refusal");
    });
    const run = await prisma.jobRun.create({ data: { kind: "SENTIMENT", orgId: org.id, projectId: project.id, createdById: owner.id, status: "PENDING" } });
    await expect(
      runJob(sentimentWorker, { projectId: project.id, period: "WEEKLY", periodStart: WEEK.start.toISOString(), jobRunId: run.id }, { jobId: "s1", attempt: 1, maxAttempts: 3 })
    ).rejects.toThrow();
    const after = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("FAILED");
    expect(after.errorMessage).toMatch(/failed for every/);
    expect(await prisma.sentimentSnapshot.count({ where: { projectId: project.id } })).toBe(0);
  });

  it("writes no snapshot for an empty window", async () => {
    const { project } = await fixture();
    const out = await runSentimentAnalysis({ projectId: project.id, period: "DAILY", periodStart: WEEK.start.toISOString() }, testLog);
    expect(out.status).toBe("empty");
    expect(llmCalls).toHaveLength(0);
    expect(await prisma.sentimentSnapshot.count()).toBe(0);
  });

  it("detects anomalies against previous snapshots, dedupes alerts per period/type and notifies admins once", async () => {
    const { owner, org, project } = await fixture();
    // Three good previous weeks.
    for (let i = 1; i <= 3; i++) {
      const start = new Date(WEEK.start.getTime() - i * 7 * 86_400_000);
      await prisma.sentimentSnapshot.create({
        data: {
          projectId: project.id,
          period: "WEEKLY",
          periodStart: start,
          periodEnd: new Date(start.getTime() + 7 * 86_400_000),
          overallScore: 0.6 + i * 0.02,
          volume: 10,
          positiveCount: 8,
          neutralCount: 1,
          negativeCount: 1,
          riskLevel: "LOW",
          topThemes: [{ name: "Onboarding", count: 5, positive: 5, neutral: 0, negative: 0, averageScore: 0.8 }],
        },
      });
    }
    // A future snapshot must not be treated as history.
    await prisma.sentimentSnapshot.create({
      data: { projectId: project.id, period: "WEEKLY", periodStart: new Date(WEEK.end.getTime()), periodEnd: new Date(WEEK.end.getTime() + 7 * 86_400_000), overallScore: -1, volume: 3, positiveCount: 0, neutralCount: 0, negativeCount: 3, riskLevel: "CRITICAL" },
    });
    await documentWithChunks(project.id, {
      chunks: ["I hate the slow sync", "Sync is broken again", "Slow exports", "Exports are broken", "Search is slow", "We will cancel at renewal"],
      createdAt: inWindow(),
    });
    scriptClassifier();
    const input = { projectId: project.id, period: "WEEKLY" as const, periodStart: WEEK.start.toISOString() };
    const first = await runSentimentAnalysis(input, testLog);
    expect(first.alertsCreated).toBeGreaterThanOrEqual(2);
    const alerts = await prisma.sentimentAlert.findMany({ where: { projectId: project.id }, orderBy: { type: "asc" } });
    const types = alerts.map((a) => a.type);
    expect(types).toContain("SPIKE_NEGATIVE");
    expect(types).toContain("TREND_DECLINE");
    expect(types).toContain("THEME_EMERGING");
    expect(new Set(types).size).toBe(types.length);

    const events = await prisma.domainEvent.count({ where: { orgId: org.id, type: "sentiment.alert" } });
    expect(events).toBe(alerts.length);
    const notes = await prisma.notification.count({ where: { userId: owner.id, type: "SENTIMENT_ALERT" } });
    expect(notes).toBe(alerts.length);

    const second = await runSentimentAnalysis(input, testLog);
    expect(second.alertsCreated).toBe(0);
    expect(await prisma.sentimentAlert.count({ where: { projectId: project.id } })).toBe(alerts.length);
    expect(await prisma.domainEvent.count({ where: { orgId: org.id, type: "sentiment.alert" } })).toBe(events);
    expect(await prisma.notification.count({ where: { userId: owner.id, type: "SENTIMENT_ALERT" } })).toBe(notes);
  });

  it("writes AI risk assessments per account from metadata, replacing the previous run's rows", async () => {
    const { owner, project } = await fixture();
    await documentWithChunks(project.id, {
      chunks: ["We will cancel at renewal unless sync is fixed", "Sync is broken for our team"],
      createdAt: inWindow(),
      metadata: { customer: { name: "Globex", id: "acct_42" }, plan: "Enterprise" },
    });
    await documentWithChunks(project.id, { chunks: ["I love the editor"], createdAt: inWindow(), metadata: { company: "Initech" } });
    scriptClassifier();
    scriptChurn();
    const input = { projectId: project.id, period: "WEEKLY" as const, periodStart: WEEK.start.toISOString() };
    await runSentimentAnalysis(input, testLog);
    const rows = await prisma.churnPrediction.findMany({ where: { projectId: project.id } });
    expect(rows).toHaveLength(1); // Initech has a single neutral/positive item and no signals
    const globex = rows[0];
    expect(globex).toMatchObject({ customerId: "id:acct_42", customerName: "Globex", segment: "enterprise", methodology: "AI_RISK_ASSESSMENT", riskLevel: "HIGH" });
    const signals = globex.signals as Array<{ source: string; label: string; detail: string | null }>;
    expect(signals.some((s) => s.source === "computed" && s.label === "Explicit churn statements")).toBe(true);
    expect(signals.find((s) => s.label === "Cancellation intent")?.detail).toBe("cancel at renewal");
    expect(signals.find((s) => s.label === "Invented")?.detail).toBeNull(); // unverifiable quote dropped

    await runSentimentAnalysis(input, testLog);
    expect(await prisma.churnPrediction.count({ where: { projectId: project.id } })).toBe(1);

    const api = insightsCaller(owner);
    const page = await api.sentiment.getChurnPredictions({ projectId: project.id });
    expect(page.items[0]).toMatchObject({ customerName: "Globex", methodology: "AI_RISK_ASSESSMENT" });
    const segments = await api.sentiment.getSegmentBreakdown({ projectId: project.id, period: "WEEKLY" });
    expect(segments.overall?.volume).toBe(3);
  });
});

describe("sentiment router", () => {
  it("does not expose org projects to outsiders (NOT_FOUND)", async () => {
    const { project } = await fixture();
    const outsider = await createUser();
    const api = insightsCaller(outsider);
    await expectTRPCCode(api.sentiment.getSnapshots({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(api.sentiment.getCurrentSentiment({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(api.sentiment.getChurnPredictions({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(api.sentiment.getAlerts({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(api.sentiment.getSegmentBreakdown({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(api.sentiment.runAnalysis({ projectId: project.id, period: "WEEKLY" }), "NOT_FOUND");
    const alert = await prisma.sentimentAlert.create({ data: { projectId: project.id, type: "TREND_DECLINE", severity: "HIGH", title: "t", description: "d" } });
    await expectTRPCCode(api.sentiment.acknowledgeAlert({ projectId: project.id, alertId: alert.id }), "NOT_FOUND");
    await expectTRPCCode(api.sentiment.resolveAlert({ projectId: project.id, alertId: alert.id }), "NOT_FOUND");
    expect(jobsFor(QUEUE.SENTIMENT)).toHaveLength(0);
  });

  it("scopes alerts to the authorized project and blocks viewers from writes", async () => {
    const { owner, org, project } = await fixture();
    const other = await createProject(owner, org.id, "Other");
    const alert = await prisma.sentimentAlert.create({ data: { projectId: other.id, type: "TREND_DECLINE", severity: "HIGH", title: "t", description: "d" } });
    const api = insightsCaller(owner);
    await expectTRPCCode(api.sentiment.acknowledgeAlert({ projectId: project.id, alertId: alert.id }), "NOT_FOUND");

    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    const asViewer = insightsCaller(viewer);
    expect((await asViewer.sentiment.getAlerts({ projectId: other.id })).items).toHaveLength(1);
    await expectTRPCCode(asViewer.sentiment.acknowledgeAlert({ projectId: other.id, alertId: alert.id }), "FORBIDDEN");
    await expectTRPCCode(asViewer.sentiment.runAnalysis({ projectId: other.id, period: "WEEKLY" }), "FORBIDDEN");

    expect(await api.sentiment.acknowledgeAlert({ projectId: other.id, alertId: alert.id })).toMatchObject({ status: "ACKNOWLEDGED" });
    expect(await api.sentiment.resolveAlert({ projectId: other.id, alertId: alert.id })).toMatchObject({ status: "RESOLVED" });
    expect(await api.sentiment.acknowledgeAlert({ projectId: other.id, alertId: alert.id })).toMatchObject({ status: "RESOLVED" });
  });

  it("runAnalysis creates a JobRun, enqueues the job and dedupes double submits", async () => {
    const { owner, project } = await fixture();
    const api = insightsCaller(owner);
    const res = await api.sentiment.runAnalysis({ projectId: project.id, period: "WEEKLY" });
    expect(res.deduplicated).toBe(false);
    const again = await api.sentiment.runAnalysis({ projectId: project.id, period: "WEEKLY" });
    expect(again).toMatchObject({ jobRunId: res.jobRunId, deduplicated: true });
    const jobs = jobsFor(QUEUE.SENTIMENT);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ projectId: project.id, period: "WEEKLY", periodStart: windowFor("WEEKLY", new Date()).start.toISOString(), jobRunId: res.jobRunId });
    expect(llmCalls).toHaveLength(0);
    const job = await api.job.get({ id: res.jobRunId });
    expect(job).toMatchObject({ status: "PENDING", kind: "SENTIMENT" });
    await expectTRPCCode(api.sentiment.runAnalysis({ projectId: project.id, period: "DAILY", periodStart: new Date(Date.now() + 3 * 86_400_000) }), "BAD_REQUEST");
  });
});

describe("sentiment scheduler and pure logic", () => {
  it("schedules daily runs for projects with new documents, weekly on Mondays, monthly on the 1st", async () => {
    const { project } = await fixture();
    const quiet = await fixture();
    const monday = new Date("2026-06-01T02:05:00Z"); // a Monday and the 1st
    await documentWithChunks(project.id, { chunks: ["x"], createdAt: new Date("2026-05-31T10:00:00Z") });
    await documentWithChunks(quiet.project.id, { chunks: ["y"], createdAt: new Date("2026-05-10T10:00:00Z") });
    const n = await scheduleSentiment(monday);
    const jobs = jobsFor(QUEUE.SENTIMENT).map((j) => j.payload as { projectId: string; period: string; periodStart: string });
    expect(jobs).toContainEqual({ projectId: project.id, period: "DAILY", periodStart: "2026-05-31T00:00:00.000Z" });
    expect(jobs).toContainEqual({ projectId: project.id, period: "WEEKLY", periodStart: "2026-05-25T00:00:00.000Z" });
    expect(jobs).toContainEqual({ projectId: project.id, period: "MONTHLY", periodStart: "2026-05-01T00:00:00.000Z" });
    expect(jobs).toContainEqual({ projectId: quiet.project.id, period: "MONTHLY", periodStart: "2026-05-01T00:00:00.000Z" });
    expect(jobs.filter((j) => j.projectId === quiet.project.id)).toHaveLength(1);
    expect(n).toBe(4);
    expect(await scheduleSentiment(monday)).toBe(4);
    expect(jobsFor(QUEUE.SENTIMENT)).toHaveLength(4); // deterministic job IDs dedupe
  });

  it("does not raise statistical alerts without enough history", () => {
    const current = aggregate([{ label: "NEGATIVE", score: -1, themes: [] }, { label: "NEGATIVE", score: -1, themes: [] }]);
    expect(detectAnomalies({ current, history: [], segments: [], highRiskAccounts: [] })).toEqual([]);
  });

  it("reads customer identity from metadata", () => {
    expect(identityFromMetadata({ accountName: "Acme Inc.", tier: "SMB" })).toEqual({ customerId: "name:acme", customerName: "Acme Inc.", segment: "smb", source: "metadata" });
    expect(identityFromMetadata({ source: "zendesk" })).toBeNull();
  });
});
