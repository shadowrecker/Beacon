/**
 * Worker for QUEUE.GAP_ANALYSIS.
 *
 * The producer (roadmap.runGapAnalysis) creates the GapAnalysis row after
 * verifying the roadmap belongs to the project; this worker updates THAT row
 * (PENDING -> PROCESSING -> READY | FAILED) and never creates another. It
 * re-checks the roadmap/project pairing as defense in depth, and the failure
 * path only touches the GapAnalysis row (never roadmap.metadata).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { emitEvent } from "@/server/events/bus";
import { getLatestThemes } from "@/server/synthesis/queries";
import { analyzeGaps, MAX_ITEMS, MAX_THEMES, type GapOutput } from "@/server/ai/roadmap/gap-analyzer";

async function emitGapDetected(row: { id: string; roadmapId: string; projectId: string; orgId: string }, output: GapOutput) {
  // Idempotent emission: a retry after a crash between "READY" and the emit
  // re-emits only if no event exists for this analysis yet.
  const existing = await prisma.domainEvent.findFirst({
    where: { type: "gap.detected", projectId: row.projectId, payload: { path: ["gapAnalysisId"], equals: row.id } },
    select: { id: true },
  });
  if (existing) return;
  await emitEvent({
    orgId: row.orgId,
    projectId: row.projectId,
    type: "gap.detected",
    payload: { gapAnalysisId: row.id, roadmapId: row.roadmapId, gapCount: output.stats.missing + output.stats.partial },
  });
}

export const gapAnalysisWorker = defineWorker({
  queue: QUEUE.GAP_ANALYSIS,
  concurrency: 2,
  handler: async ({ gapAnalysisId }, ctx) => {
    const row = await prisma.gapAnalysis.findUnique({
      where: { id: gapAnalysisId },
      select: {
        id: true,
        status: true,
        projectId: true,
        roadmapId: true,
        output: true,
        project: { select: { orgId: true } },
        roadmap: { select: { projectId: true } },
      },
    });
    if (!row) throw new NonRetryableError("Gap analysis not found");
    if (row.roadmap.projectId !== row.projectId) {
      throw new NonRetryableError("The roadmap does not belong to this project");
    }
    const ref = { id: row.id, roadmapId: row.roadmapId, projectId: row.projectId, orgId: row.project.orgId };
    if (row.status === "READY") {
      // Already finished (duplicate delivery); make sure the event went out.
      const done = row.output as unknown as GapOutput | null;
      if (done?.stats) await emitGapDetected(ref, done);
      return { status: "READY", skipped: true };
    }
    if (row.status === "FAILED") return { status: "FAILED", skipped: true };

    await prisma.gapAnalysis.update({ where: { id: row.id }, data: { status: "PROCESSING", errorMessage: null } });
    await ctx.updateProgress(10);

    const latest = await getLatestThemes(row.projectId, { limit: MAX_THEMES, quotesPerTheme: 2 });
    if (!latest.synthesisId || latest.themes.length === 0) {
      throw new NonRetryableError("No completed synthesis with themes was found. Run a synthesis first.");
    }
    const totalThemes = await prisma.theme.count({ where: { synthesisId: latest.synthesisId } });

    // Load one more than the prompt can hold so the analyzer can report what it skipped.
    const items = await prisma.roadmapItem.findMany({
      where: { roadmapId: row.roadmapId, roadmap: { projectId: row.projectId } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: MAX_ITEMS * 4,
      select: { id: true, title: true, description: true, status: true, priority: true, quarter: true },
    });
    const totalItems = await prisma.roadmapItem.count({ where: { roadmapId: row.roadmapId } });
    if (totalItems === 0) throw new NonRetryableError("The roadmap has no items to analyze");
    await ctx.updateProgress(25);

    const { output, evidenceDensity } = await analyzeGaps({
      orgId: ref.orgId,
      projectId: row.projectId,
      synthesisId: latest.synthesisId,
      themes: latest.themes,
      items,
      skippedThemes: Math.max(0, totalThemes - latest.themes.length),
    });
    // Items beyond what we loaded also count as skipped.
    output.skipped.roadmapItems += Math.max(0, totalItems - items.length);
    await ctx.updateProgress(90);

    await prisma.gapAnalysis.update({
      where: { id: row.id },
      data: {
        status: "READY",
        synthesisId: latest.synthesisId,
        output: output as unknown as Prisma.InputJsonValue,
        evidenceDensity: evidenceDensity as unknown as Prisma.InputJsonValue,
        errorMessage: null,
        completedAt: new Date(),
      },
    });
    await emitGapDetected(ref, output);
    return { status: "READY", covered: output.stats.covered, partial: output.stats.partial, missing: output.stats.missing };
  },
  onFinalFailure: async ({ gapAnalysisId }, error) => {
    // Only this analysis row is marked failed; the roadmap is never modified.
    await prisma.gapAnalysis.updateMany({
      where: { id: gapAnalysisId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: failureMessage(error), completedAt: new Date() },
    });
  },
});
