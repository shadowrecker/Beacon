/**
 * One sentiment analysis run for (project, period, periodStart).
 *
 * - Analyzes only chunks of READY documents created inside the period window,
 *   capped at MAX_CHUNKS_PER_RUN by a deterministic sample (recorded).
 * - Classifies per chunk on the bulk model in bounded batches. If every
 *   classification fails the run fails; no zero-volume snapshot is written.
 * - Upserts the project-wide snapshot and per-segment snapshots on their unique
 *   key, compares against the previous snapshots (most recent first, current
 *   excluded) and records alerts deduplicated per period and type.
 * - For weekly/monthly and manual runs, replaces the churn "AI risk
 *   assessment" rows with this run's assessments.
 * - New alerts emit `sentiment.alert` and notify the org's admins after commit;
 *   a `notified` flag on the alert makes that step retry-safe.
 */
import type { Prisma, SentimentPeriod } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { NonRetryableError } from "../../jobs/worker";
import { emitEvent } from "../../events/bus";
import { notify } from "../../notifications/notify";
import { aggregate, aggregateBySegment, type ThemeStat } from "./aggregate";
import { detectAnomalies, type HistoryPoint } from "./anomalies";
import { assessAccounts, CHURN_METHODOLOGY, type AccountGroup, type AccountItem } from "./churn";
import { classifyChunks } from "./classify";
import { identityFromMetadata, identityFromText, segmentFromMetadata } from "./customers";
import { describeWindow, lastCompleteWindow, periodKey, windowFor, type PeriodWindow } from "./periods";

export const MAX_CHUNKS_PER_RUN = 2_000;
const HISTORY_PERIODS = 12;

export interface SentimentJobInput {
  projectId: string;
  period: SentimentPeriod;
  periodStart?: string;
  jobRunId?: string;
}

export interface SentimentRunOutput {
  status: "analyzed" | "empty";
  period: SentimentPeriod;
  periodStart: string;
  periodEnd: string;
  totalChunks: number;
  sampledChunks: number;
  classifiedChunks: number;
  failedChunks: number;
  truncatedChunks: number;
  volume: number;
  overallScore: number | null;
  riskLevel: string | null;
  segments: number;
  alertsCreated: number;
  churn: { status: "assessed" | "skipped" | "failed"; accounts: number; failedAccounts: number };
}

interface SampleRow {
  id: string;
  content: string;
  documentId: string;
  metadata: unknown;
}

export function sentimentWindow(input: Pick<SentimentJobInput, "period" | "periodStart">, now = new Date()): PeriodWindow {
  return input.periodStart ? windowFor(input.period, new Date(input.periodStart)) : lastCompleteWindow(input.period, now);
}

function parseThemes(v: unknown): ThemeStat[] {
  return Array.isArray(v) ? (v.filter((t) => t && typeof t === "object" && typeof (t as ThemeStat).name === "string") as ThemeStat[]) : [];
}

export async function runSentimentAnalysis(
  input: SentimentJobInput,
  log: Logger,
  onProgress: (pct: number) => Promise<void> = async () => undefined
): Promise<SentimentRunOutput> {
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, orgId: true, name: true } });
  if (!project) throw new NonRetryableError("Project not found");
  const projectId = project.id;
  const orgId = project.orgId;

  if (input.jobRunId) {
    const run = await prisma.jobRun.findFirst({
      where: { id: input.jobRunId, projectId, kind: "SENTIMENT" },
      select: { status: true, output: true },
    });
    if (!run) throw new NonRetryableError("Sentiment job not found");
    if (run.status === "READY" && run.output) return run.output as unknown as SentimentRunOutput;
    await prisma.jobRun.update({ where: { id: input.jobRunId }, data: { status: "PROCESSING", startedAt: new Date(), errorMessage: null } });
  }

  const now = new Date();
  const window = sentimentWindow(input, now);
  if (window.start > now) throw new NonRetryableError("This period has not started yet");
  const base = {
    period: window.period,
    periodStart: window.start.toISOString(),
    periodEnd: window.end.toISOString(),
  };

  const [{ total }] = await prisma.$queryRaw<Array<{ total: number }>>`
    SELECT count(*)::int AS total
    FROM chunks c JOIN documents d ON d.id = c."documentId"
    WHERE c."projectId" = ${projectId} AND d."projectId" = ${projectId}
      AND d.status = 'READY'::"DocumentStatus"
      AND d."createdAt" >= ${window.start} AND d."createdAt" < ${window.end}`;

  if (total === 0) {
    const output: SentimentRunOutput = {
      status: "empty",
      ...base,
      totalChunks: 0,
      sampledChunks: 0,
      classifiedChunks: 0,
      failedChunks: 0,
      truncatedChunks: 0,
      volume: 0,
      overallScore: null,
      riskLevel: null,
      segments: 0,
      alertsCreated: 0,
      churn: { status: "skipped", accounts: 0, failedAccounts: 0 },
    };
    await prisma.$transaction(async (tx) => {
      // Documents in the window were removed since the last run: drop the stale snapshots.
      await tx.sentimentSnapshot.deleteMany({ where: { projectId, period: window.period, periodStart: window.start } });
      if (input.jobRunId) await completeRun(tx, input.jobRunId, output);
    });
    return output;
  }

  // Deterministic sample when the window holds more than the per-run cap.
  const sample = await prisma.$queryRaw<SampleRow[]>`
    SELECT c.id, c.content, c."documentId" AS "documentId", d.metadata
    FROM chunks c JOIN documents d ON d.id = c."documentId"
    WHERE c."projectId" = ${projectId} AND d."projectId" = ${projectId}
      AND d.status = 'READY'::"DocumentStatus"
      AND d."createdAt" >= ${window.start} AND d."createdAt" < ${window.end}
    ORDER BY md5(c.id)
    LIMIT ${MAX_CHUNKS_PER_RUN}`;
  const usable = sample.filter((c) => c.content.trim().length > 0);
  if (sample.length < total) log.info("sentiment sample capped", { projectId, total, sampled: sample.length });
  await onProgress(5);

  const classified = await classifyChunks(
    usable.map((c) => ({ id: c.id, content: c.content })),
    { orgId, projectId },
    log
  );
  await onProgress(70);
  if (classified.results.length === 0) {
    throw new NonRetryableError("Sentiment classification failed for every sampled feedback item");
  }

  const byId = new Map(usable.map((c) => [c.id, c]));
  const items: Array<AccountItem & { segment: string | null; customerKey: string | null }> = [];
  const groups = new Map<string, AccountGroup>();
  for (const r of classified.results) {
    const chunk = byId.get(r.chunkId);
    if (!chunk) continue;
    const metaSegment = segmentFromMetadata(chunk.metadata);
    const identity = identityFromMetadata(chunk.metadata) ?? identityFromText(r.customer, metaSegment);
    const item = { ...r, content: chunk.content, segment: identity?.segment ?? metaSegment, customerKey: identity?.customerId ?? null };
    items.push(item);
    if (identity) {
      const g = groups.get(identity.customerId) ?? { identity, items: [] };
      g.items.push(item);
      groups.set(identity.customerId, g);
    }
  }

  const figures = aggregate(items);
  const segments = aggregateBySegment(items);

  const shouldAssess = !!input.jobRunId || window.period !== "DAILY";
  const churn =
    shouldAssess && groups.size > 0
      ? await assessAccounts([...groups.values()], { orgId, projectId, windowLabel: describeWindow(window) }, log)
      : null;
  await onProgress(90);

  const churnStatus: SentimentRunOutput["churn"] = !churn
    ? { status: "skipped", accounts: 0, failedAccounts: 0 }
    : churn.allFailed
      ? { status: "failed", accounts: 0, failedAccounts: churn.failedAccounts }
      : { status: "assessed", accounts: churn.assessments.length, failedAccounts: churn.failedAccounts };

  const key = periodKey(window);
  const { output, alertIds } = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sent:${projectId}`}))`;

      const snapshotData = (segment: string, f: typeof figures) => ({
        periodEnd: window.end,
        overallScore: f.overallScore,
        volume: f.volume,
        positiveCount: f.positiveCount,
        neutralCount: f.neutralCount,
        negativeCount: f.negativeCount,
        topThemes: f.topThemes as unknown as Prisma.InputJsonValue,
        riskLevel: f.riskLevel,
        customerSegment: segment,
      });
      const uniqueKey = (segment: string) => ({
        projectId_period_periodStart_customerSegment: { projectId, period: window.period, periodStart: window.start, customerSegment: segment },
      });
      for (const [segment, f] of [["all", figures] as const, ...segments.map((s) => [s.segment, s.figures] as const)]) {
        const data = snapshotData(segment, f);
        await tx.sentimentSnapshot.upsert({
          where: uniqueKey(segment),
          create: { projectId, period: window.period, periodStart: window.start, ...data },
          update: data,
        });
      }
      await tx.sentimentSnapshot.deleteMany({
        where: { projectId, period: window.period, periodStart: window.start, customerSegment: { notIn: ["all", ...segments.map((s) => s.segment)] } },
      });

      const history = await tx.sentimentSnapshot.findMany({
        where: { projectId, period: window.period, customerSegment: "all", periodStart: { lt: window.start } },
        orderBy: { periodStart: "desc" },
        take: HISTORY_PERIODS,
        select: { periodStart: true, overallScore: true, volume: true, negativeCount: true, topThemes: true },
      });
      const historyPoints: HistoryPoint[] = history.map((h) => ({ ...h, topThemes: parseThemes(h.topThemes) }));
      const highRisk = (churn && !churn.allFailed ? churn.assessments : [])
        .filter((a) => a.riskLevel === "HIGH" || a.riskLevel === "CRITICAL")
        .map((a) => ({ customerName: a.customerName, riskLevel: a.riskLevel }));
      const candidates = detectAnomalies({ current: figures, history: historyPoints, segments, highRiskAccounts: highRisk });

      let alertsCreated = 0;
      for (const c of candidates) {
        const existing = await tx.sentimentAlert.findFirst({
          where: { projectId, type: c.type, dataPoints: { path: ["periodKey"], equals: key } },
          select: { id: true, status: true, dataPoints: true },
        });
        const notified = existing ? Boolean((existing.dataPoints as Record<string, unknown> | null)?.notified) : false;
        const dataPoints = { ...c.dataPoints, periodKey: key, period: window.period, periodStart: window.start.toISOString(), notified } as Prisma.InputJsonValue;
        if (existing) {
          if (existing.status === "NEW") {
            await tx.sentimentAlert.update({
              where: { id: existing.id },
              data: { severity: c.severity, title: c.title, description: c.description, dataPoints },
            });
          }
          continue;
        }
        await tx.sentimentAlert.create({
          data: { projectId, type: c.type, severity: c.severity, title: c.title.slice(0, 200), description: c.description, dataPoints },
        });
        alertsCreated++;
      }

      if (churn && !churn.allFailed) {
        const runId = input.jobRunId ?? `sched_${window.period}_${window.start.toISOString()}`;
        await tx.churnPrediction.deleteMany({ where: { projectId } });
        if (churn.assessments.length > 0) {
          await tx.churnPrediction.createMany({
            data: churn.assessments.map((a) => ({
              projectId,
              runId,
              customerId: a.customerId,
              customerName: a.customerName,
              segment: a.segment,
              churnProbability: a.churnProbability,
              riskLevel: a.riskLevel,
              confidence: a.confidence,
              signals: a.signals as unknown as Prisma.InputJsonValue,
              recommendations: a.recommendations as unknown as Prisma.InputJsonValue,
              predictedChurnDate: null,
              methodology: CHURN_METHODOLOGY,
            })),
          });
        }
      }

      const out: SentimentRunOutput = {
        status: "analyzed",
        ...base,
        totalChunks: total,
        sampledChunks: sample.length,
        classifiedChunks: classified.results.length,
        failedChunks: classified.failedChunks,
        truncatedChunks: classified.truncatedChunks,
        volume: figures.volume,
        overallScore: figures.overallScore,
        riskLevel: figures.riskLevel,
        segments: segments.length,
        alertsCreated,
        churn: churnStatus,
      };
      if (input.jobRunId) await completeRun(tx, input.jobRunId, out);

      const pending = await tx.sentimentAlert.findMany({
        where: { projectId, dataPoints: { path: ["periodKey"], equals: key } },
        select: { id: true, dataPoints: true },
      });
      return {
        output: out,
        alertIds: pending.filter((a) => !(a.dataPoints as Record<string, unknown> | null)?.notified).map((a) => a.id),
      };
    },
    { timeout: 60_000, maxWait: 15_000 }
  );

  if (alertIds.length > 0) await announceAlerts(orgId, projectId, project.name, alertIds, log);
  return output;
}

async function completeRun(tx: Prisma.TransactionClient, jobRunId: string, output: SentimentRunOutput): Promise<void> {
  await tx.jobRun.update({
    where: { id: jobRunId },
    data: { status: "READY", output: output as unknown as Prisma.InputJsonValue, completedAt: new Date(), errorMessage: null },
  });
}

/** Emit `sentiment.alert` and notify admins for alerts not yet announced; then mark them. */
async function announceAlerts(orgId: string, projectId: string, projectName: string, alertIds: string[], log: Logger): Promise<void> {
  const admins = await prisma.orgMember.findMany({
    where: { orgId, role: { in: ["OWNER", "ADMIN"] }, joinedAt: { not: null } },
    select: { userId: true },
    take: 50,
  });
  for (const alertId of alertIds) {
    const alert = await prisma.sentimentAlert.findFirst({
      where: { id: alertId, projectId },
      select: { id: true, type: true, severity: true, title: true, description: true, dataPoints: true },
    });
    if (!alert) continue;
    await emitEvent({ orgId, projectId, type: "sentiment.alert", payload: { alertId: alert.id, type: alert.type, severity: alert.severity, title: alert.title } });
    await notify({
      userIds: admins.map((a) => a.userId),
      type: "SENTIMENT_ALERT",
      title: `${projectName}: ${alert.title}`.slice(0, 200),
      message: alert.description.slice(0, 1000),
      resourceType: "sentiment_alert",
      resourceId: alert.id,
      href: `/projects/${projectId}/sentiment`,
      dedupeKey: `sentiment-alert:${alert.id}`,
    });
    const dp = (alert.dataPoints ?? {}) as Record<string, unknown>;
    await prisma.sentimentAlert.update({ where: { id: alert.id }, data: { dataPoints: { ...dp, notified: true } as Prisma.InputJsonValue } });
    log.info("sentiment alert announced", { alertId: alert.id, type: alert.type });
  }
}
