/**
 * Worker for QUEUE.PRESENTATIONS.
 *
 * Generates slides from bounded project data (latest themes, top
 * recommendations, tracked outcomes), renders PPTX and PDF into storage and
 * stores the object keys on the row, then moves THAT row to READY and emits
 * presentation.ready. Final failures set FAILED with a presentable message.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { emitEvent } from "@/server/events/bus";
import { getLatestThemes } from "@/server/synthesis/queries";
import { generateDeck, MAX_DECK_OUTCOMES, MAX_DECK_RECOMMENDATIONS, MAX_DECK_THEMES } from "@/server/ai/presentation/generator";
import { readSlidesData, type SlidesData } from "@/server/ai/presentation/schema";
import { resolveTemplate } from "@/server/ai/presentation/templates";
import { deleteDeckObjects, renderAndStore } from "@/server/ai/presentation/storage";

async function emitReadyOnce(p: { id: string; projectId: string; title: string; orgId: string }, since: Date) {
  const existing = await prisma.domainEvent.findFirst({
    where: { type: "presentation.ready", projectId: p.projectId, createdAt: { gte: since }, payload: { path: ["presentationId"], equals: p.id } },
    select: { id: true },
  });
  if (existing) return;
  await emitEvent({
    orgId: p.orgId,
    projectId: p.projectId,
    type: "presentation.ready",
    payload: { presentationId: p.id, title: p.title },
  });
}

export const presentationWorker = defineWorker({
  queue: QUEUE.PRESENTATIONS,
  concurrency: 2,
  handler: async ({ presentationId }, ctx) => {
    const p = await prisma.presentation.findUnique({
      where: { id: presentationId },
      select: {
        id: true,
        projectId: true,
        userId: true,
        title: true,
        audience: true,
        type: true,
        status: true,
        themeColor: true,
        slidesData: true,
        project: { select: { orgId: true, name: true, description: true } },
      },
    });
    if (!p) throw new NonRetryableError("Presentation not found");
    const ref = { id: p.id, projectId: p.projectId, title: p.title, orgId: p.project.orgId };
    const data = readSlidesData(p.slidesData, p.title);
    if (p.status === "READY") {
      // Duplicate delivery after completion: make sure the event went out.
      if (data.generatedAt) await emitReadyOnce(ref, new Date(data.generatedAt));
      return { status: "READY", skipped: true };
    }
    if (p.status !== "GENERATING") return { status: p.status, skipped: true };

    const template = await resolveTemplate(data.templateId, p.project.orgId);
    const [latest, recommendations, outcomes] = await Promise.all([
      getLatestThemes(p.projectId, { limit: MAX_DECK_THEMES, quotesPerTheme: 2 }),
      prisma.recommendation.findMany({
        where: { projectId: p.projectId, status: { not: "REJECTED" } },
        orderBy: [{ impact: "asc" }, { confidence: "desc" }, { createdAt: "desc" }],
        take: MAX_DECK_RECOMMENDATIONS,
        select: { title: true, description: true, impact: true, confidence: true, status: true },
      }),
      prisma.outcomeTracking.findMany({
        where: { recommendation: { projectId: p.projectId } },
        orderBy: { updatedAt: "desc" },
        take: MAX_DECK_OUTCOMES,
        select: {
          status: true,
          metricName: true,
          baselineValue: true,
          currentValue: true,
          targetValue: true,
          recommendation: { select: { title: true } },
        },
      }),
    ]);
    if (latest.themes.length === 0 && recommendations.length === 0) {
      throw new NonRetryableError("There is nothing to present yet. Run a synthesis or generate recommendations first.");
    }
    await ctx.updateProgress(20);

    const slides = await generateDeck({
      orgId: p.project.orgId,
      projectId: p.projectId,
      project: { name: p.project.name, description: p.project.description },
      title: p.title,
      audience: p.audience,
      type: p.type,
      template,
      themes: latest.themes,
      recommendations,
      outcomes: outcomes.map((o) => ({ ...o, title: o.recommendation.title })),
    });
    await ctx.updateProgress(70);

    const revision = data.revision + 1;
    const generatedAt = new Date();
    const next: SlidesData = {
      ...data,
      title: p.title,
      slides,
      revision,
      rendered: { pptx: revision, pdf: revision },
      generatedAt: generatedAt.toISOString(),
    };
    const keys = await renderAndStore(p, next, ["pptx", "pdf"]);
    await ctx.updateProgress(90);

    const res = await prisma.presentation.updateMany({
      where: { id: p.id, status: "GENERATING" },
      data: {
        status: "READY",
        errorMessage: null,
        slidesData: next as unknown as Prisma.InputJsonValue,
        pptxUrl: keys.pptx ?? null,
        pdfUrl: keys.pdf ?? null,
      },
    });
    if (res.count === 0) {
      // Deleted (or otherwise changed) while generating: don't leave orphaned objects.
      const still = await prisma.presentation.findUnique({ where: { id: p.id }, select: { id: true } });
      if (!still) await deleteDeckObjects(p.projectId, p.id, [keys.pptx ?? null, keys.pdf ?? null]);
      return { status: "SUPERSEDED" };
    }
    await emitReadyOnce(ref, generatedAt);
    return { status: "READY", slides: slides.length };
  },
  onFinalFailure: async ({ presentationId }, error) => {
    await prisma.presentation.updateMany({
      where: { id: presentationId, status: "GENERATING" },
      data: { status: "FAILED", errorMessage: failureMessage(error) },
    });
  },
});
