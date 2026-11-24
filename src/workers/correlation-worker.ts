/**
 * Worker for QUEUE.CORRELATION.
 *
 * Updates the producer's JobRun (kind CORRELATION). Correlations are computed in
 * code (see ai/analytics/correlator.ts); the LLM only writes the narrative.
 * Results are upserted on UsageCorrelation's unique key and stale rows for the
 * project are removed in the same transaction, so re-runs and retries never
 * duplicate. correlation.found is emitted for correlations that became strong
 * in this run (relative to the state captured before the first attempt).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { emitEvent } from "@/server/events/bus";
import { getLatestThemes } from "@/server/synthesis/queries";
import { loadProjectSeries } from "@/server/ai/analytics/importer";
import {
  computeCorrelations,
  isStrong,
  loadThemeMentions,
  narrateCorrelations,
  STRONG_THRESHOLD,
} from "@/server/ai/analytics/correlator";

/** Stable key for a correlation (stored in JobRun.output, so no control characters). */
const keyOf = (c: { themeId: string; featureName: string; usageMetric: string }) =>
  JSON.stringify([c.themeId, c.featureName, c.usageMetric]);

interface RunProgress {
  phase: "processing";
  previousStrong: string[];
}

export const correlationWorker = defineWorker({
  queue: QUEUE.CORRELATION,
  concurrency: 2,
  handler: async ({ jobRunId, projectId }, ctx) => {
    const run = await prisma.jobRun.findUnique({
      where: { id: jobRunId },
      select: { id: true, kind: true, status: true, projectId: true, orgId: true, output: true, createdAt: true },
    });
    if (!run || run.kind !== "CORRELATION" || run.projectId !== projectId) {
      throw new NonRetryableError("Correlation run not found");
    }
    if (run.status === "READY" || run.status === "FAILED") return { status: run.status, skipped: true };
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, orgId: true } });
    if (!project || project.orgId !== run.orgId) throw new NonRetryableError("Project not found");

    // Capture which correlations were already strong before this run, once,
    // so a retry emits the same set of "newly strong" events.
    let progress = run.output as unknown as RunProgress | null;
    if (!progress || progress.phase !== "processing") {
      const before = await prisma.usageCorrelation.findMany({
        where: { projectId, OR: [{ correlationScore: { gte: STRONG_THRESHOLD } }, { correlationScore: { lte: -STRONG_THRESHOLD } }] },
        select: { themeId: true, featureName: true, usageMetric: true },
        take: 1_000,
      });
      progress = { phase: "processing", previousStrong: before.map(keyOf) };
    }
    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "PROCESSING",
        startedAt: new Date(),
        errorMessage: null,
        output: progress as unknown as Prisma.InputJsonValue,
      },
    });
    await ctx.updateProgress(10);

    const latest = await getLatestThemes(projectId, { limit: 40, quotesPerTheme: 0 });
    if (latest.themes.length === 0) throw new NonRetryableError("No themes found. Run a synthesis first.");
    const { series, importsUsed, pointsSkipped } = await loadProjectSeries(projectId);
    if (series.length === 0) throw new NonRetryableError("No usage data found. Import analytics data first.");
    const mentions = await loadThemeMentions(projectId, latest.themes.map((t) => t.id));
    await ctx.updateProgress(30);

    const result = computeCorrelations({
      themes: latest.themes.map((t) => ({ id: t.id, name: t.name, description: t.description })),
      mentions,
      series,
    });
    await ctx.updateProgress(50);

    const { insights, source } = await narrateCorrelations({ orgId: run.orgId, projectId }, result.candidates, result.unit);
    await ctx.updateProgress(80);

    const saved = await prisma.$transaction(async (tx) => {
      const rows: Array<{ id: string; themeId: string; featureName: string; usageMetric: string; correlationScore: number }> = [];
      for (const [i, c] of result.candidates.entries()) {
        const row = await tx.usageCorrelation.upsert({
          where: {
            projectId_themeId_featureName_usageMetric: {
              projectId,
              themeId: c.themeId,
              featureName: c.featureName,
              usageMetric: c.usageMetric,
            },
          },
          create: {
            projectId,
            themeId: c.themeId,
            featureName: c.featureName,
            usageMetric: c.usageMetric,
            correlationScore: c.score,
            direction: c.direction,
            insight: insights[i],
          },
          update: { correlationScore: c.score, direction: c.direction, insight: insights[i] },
          select: { id: true, themeId: true, featureName: true, usageMetric: true, correlationScore: true },
        });
        rows.push(row);
      }
      // Correlations from earlier runs that no longer hold (or belong to older themes).
      const removed = await tx.usageCorrelation.deleteMany({
        where: { projectId, id: { notIn: rows.map((r) => r.id) } },
      });
      return { rows, removed: removed.count };
    }, { timeout: 30_000 });

    const previous = new Set(progress.previousStrong);
    const newlyStrong = saved.rows.filter((r, i) => isStrong(r.correlationScore, result.candidates[i].points) && !previous.has(keyOf(r)));

    const output = {
      phase: "done",
      unit: result.unit,
      pairsEvaluated: result.pairsEvaluated,
      pairsWithEnoughData: result.pairsWithEnoughData,
      correlations: saved.rows.length,
      strong: saved.rows.filter((r, i) => isStrong(r.correlationScore, result.candidates[i].points)).length,
      newlyStrong: newlyStrong.length,
      removedStale: saved.removed,
      insightSource: source,
      themes: latest.themes.length,
      series: series.length,
      importsUsed,
      skipped: { correlationsBeyondCap: result.dropped, points: pointsSkipped, citationsTruncated: mentions.truncated },
    };
    // Emit before marking READY: a retry recomputes the same newly-strong set and
    // the existence check skips events already written.
    for (const r of newlyStrong) {
      const exists = await prisma.domainEvent.findFirst({
        where: {
          type: "correlation.found",
          projectId,
          createdAt: { gte: run.createdAt },
          payload: { path: ["correlationId"], equals: r.id },
        },
        select: { id: true },
      });
      if (exists) continue;
      await emitEvent({
        orgId: run.orgId,
        projectId,
        type: "correlation.found",
        payload: { correlationId: r.id, themeId: r.themeId, featureName: r.featureName, score: r.correlationScore },
      });
    }
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: "READY", output: output as unknown as Prisma.InputJsonValue, completedAt: new Date(), errorMessage: null },
    });

    return output;
  },
  onFinalFailure: async ({ jobRunId }, error) => {
    await prisma.jobRun.updateMany({
      where: { id: jobRunId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: failureMessage(error), completedAt: new Date() },
    });
  },
});
