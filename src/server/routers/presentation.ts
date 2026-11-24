/**
 * Presentations: generated stakeholder decks.
 *
 * create/regenerate set the row to GENERATING and enqueue QUEUE.PRESENTATIONS;
 * the worker writes slidesData and renders PPTX + PDF into storage, storing the
 * object KEYS in pptxUrl/pdfUrl. Exports return short-lived presigned URLs and
 * re-render first when slides were edited since the last render. themeColor is
 * validated as #RRGGBB here and again in every renderer.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { getStorage, keyBelongsToProject } from "@/lib/storage";
import { router, protectedProcedure, llmProcedure, rateLimited } from "../trpc";
import { found, memberOrgIds, requireProjectAccess, type Permission } from "../auth/access";
import type { Context } from "../context";
import { enqueue, QUEUE } from "../jobs/queues";
import {
  DEFAULT_THEME_COLOR,
  emptySlidesData,
  readSlidesData,
  slideEditSchema,
  themeColorSchema,
  type SlidesData,
} from "../ai/presentation/schema";
import { builtInTemplateSummaries, outlineFromStructure, resolveTemplate, type TemplateSummary } from "../ai/presentation/templates";
import { deleteDeckObjects, downloadName, renderAndStore, type DeckFormat } from "../ai/presentation/storage";

const writeProcedure = protectedProcedure.use(rateLimited(RATE_LIMITS.write));
const id = z.string().min(1).max(64);
const audienceEnum = z.enum(["EXECUTIVE", "ENGINEERING", "CUSTOMER", "BOARD", "SALES", "INVESTOR"]);
const typeEnum = z.enum(["SYNTHESIS_READOUT", "RECOMMENDATION_PITCH", "QBR", "LAUNCH_BRIEF", "CUSTOM"]);
const DOWNLOAD_TTL_SEC = 300;

function page<T extends { id: string }>(rows: T[], take: number) {
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

const json = (d: SlidesData) => d as unknown as Prisma.InputJsonValue;

/** Load a presentation and authorize its project (NOT_FOUND for outsiders). */
async function loadPresentation(ctx: Pick<Context, "prisma" | "user">, presentationId: string, permission: Permission) {
  const p = found(
    await ctx.prisma.presentation.findUnique({
      where: { id: presentationId },
      select: {
        id: true,
        projectId: true,
        userId: true,
        title: true,
        audience: true,
        type: true,
        status: true,
        errorMessage: true,
        slidesData: true,
        pptxUrl: true,
        pdfUrl: true,
        themeColor: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    "Presentation"
  );
  const project = await requireProjectAccess(ctx, p.projectId, permission);
  return { p, project };
}

async function exportDeck(ctx: Pick<Context, "prisma" | "user">, presentationId: string, format: DeckFormat) {
  const { p } = await loadPresentation(ctx, presentationId, "data:export");
  if (p.status !== "READY") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: p.status === "GENERATING" ? "The presentation is still generating" : "Generation failed; regenerate the presentation first",
    });
  }
  const data = readSlidesData(p.slidesData, p.title);
  if (data.slides.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "The presentation has no slides" });
  const storage = getStorage();
  const storedKey = format === "pptx" ? p.pptxUrl : p.pdfUrl;
  const renderedRevision = data.rendered?.[format] ?? -1;
  let key = storedKey && keyBelongsToProject(storedKey, p.projectId) ? storedKey : null;
  const stale = !key || renderedRevision !== data.revision || !(await storage.head(key));
  if (stale) {
    const keys = await renderAndStore(p, data, [format]);
    key = keys[format]!;
    const rendered = { pptx: data.rendered?.pptx ?? -1, pdf: data.rendered?.pdf ?? -1, [format]: data.revision };
    await ctx.prisma.presentation.update({
      where: { id: p.id },
      data: { ...(format === "pptx" ? { pptxUrl: key } : { pdfUrl: key }), slidesData: json({ ...data, rendered }) },
    });
  }
  const url = await storage.presignGet(key!, { expiresInSec: DOWNLOAD_TTL_SEC, downloadName: downloadName(p.title, format) });
  return { url, fileName: downloadName(p.title, format), expiresAt: new Date(Date.now() + DOWNLOAD_TTL_SEC * 1000), rerendered: stale };
}

export const presentationRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        projectId: id,
        status: z.enum(["GENERATING", "READY", "FAILED"]).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.presentation.findMany({
        where: { projectId: project.id, ...(input.status ? { status: input.status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          title: true,
          audience: true,
          type: true,
          status: true,
          errorMessage: true,
          themeColor: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { id: true, name: true } },
        },
      });
      return page(rows, input.limit);
    }),

  get: protectedProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const { p, project } = await loadPresentation(ctx, input.id, "project:read");
    const data = readSlidesData(p.slidesData, p.title);
    return {
      id: p.id,
      projectId: p.projectId,
      projectName: project.name,
      title: p.title,
      audience: p.audience,
      type: p.type,
      status: p.status,
      errorMessage: p.errorMessage,
      themeColor: p.themeColor,
      templateId: data.templateId,
      revision: data.revision,
      generatedAt: data.generatedAt,
      slides: data.slides,
      hasPptx: Boolean(p.pptxUrl),
      hasPdf: Boolean(p.pdfUrl),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }),

  create: llmProcedure
    .input(
      z.object({
        projectId: id,
        title: z.string().trim().min(1, "Title is required").max(200),
        audience: audienceEnum,
        type: typeEnum,
        themeColor: themeColorSchema.optional(),
        templateId: z.string().min(1).max(100).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
      const template = input.templateId ? found(await resolveTemplate(input.templateId, project.orgId), "Template") : null;
      const row = await ctx.prisma.presentation.create({
        data: {
          projectId: project.id,
          userId: ctx.user.id,
          title: input.title,
          audience: input.audience,
          type: input.type,
          status: "GENERATING",
          themeColor: (input.themeColor ?? template?.themeColor ?? DEFAULT_THEME_COLOR).toUpperCase(),
          slidesData: json(emptySlidesData(template?.id ?? null, input.title)),
        },
        select: { id: true, status: true, title: true },
      });
      await enqueue(QUEUE.PRESENTATIONS, { presentationId: row.id }, { jobId: `pres_${row.id}_0` });
      return row;
    }),

  regenerate: llmProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const { p } = await loadPresentation(ctx, input.id, "ai:run");
    // Atomic transition so a double click can't enqueue two generations.
    const res = await ctx.prisma.presentation.updateMany({
      where: { id: p.id, status: { not: "GENERATING" } },
      data: { status: "GENERATING", errorMessage: null },
    });
    if (res.count === 0) throw new TRPCError({ code: "CONFLICT", message: "The presentation is already generating" });
    await enqueue(QUEUE.PRESENTATIONS, { presentationId: p.id }, { jobId: `pres_${p.id}_${Date.now()}` });
    return { id: p.id, status: "GENERATING" as const };
  }),

  updateSlide: writeProcedure
    .input(z.object({ id, slideNumber: z.number().int().min(1).max(30) }).extend(slideEditSchema.shape))
    .mutation(async ({ ctx, input }) => {
      const { p } = await loadPresentation(ctx, input.id, "project:write");
      if (p.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "Slides can be edited once the presentation is ready" });
      const data = readSlidesData(p.slidesData, p.title);
      const idx = data.slides.findIndex((s) => s.slideNumber === input.slideNumber);
      if (idx < 0) throw new TRPCError({ code: "NOT_FOUND", message: "Slide not found" });
      const current = data.slides[idx];
      const slide = {
        ...current,
        title: input.title,
        subtitle: input.subtitle,
        bulletPoints: input.bulletPoints,
        speakerNotes: input.speakerNotes,
        layout: input.layout ?? current.layout,
      };
      const next: SlidesData = { ...data, revision: data.revision + 1, slides: data.slides.map((s, i) => (i === idx ? slide : s)) };
      // Optimistic concurrency: only apply if nobody else changed the deck meanwhile.
      const res = await ctx.prisma.presentation.updateMany({
        where: { id: p.id, updatedAt: p.updatedAt, status: "READY" },
        data: { slidesData: json(next) },
      });
      if (res.count === 0) throw new TRPCError({ code: "CONFLICT", message: "The presentation changed while you were editing. Reload and try again." });
      return { slide, revision: next.revision };
    }),

  delete: writeProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const { p } = await loadPresentation(ctx, input.id, "project:write");
    await deleteDeckObjects(p.projectId, p.id, [p.pptxUrl, p.pdfUrl]);
    await ctx.prisma.presentation.delete({ where: { id: p.id } });
    return { id: p.id };
  }),

  /** Built-in templates plus public and org templates visible to the caller. */
  listTemplates: protectedProcedure
    .input(z.object({ audience: audienceEnum.optional(), type: typeEnum.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const orgIds = await memberOrgIds(ctx.prisma, ctx.user.id);
      const rows = await ctx.prisma.presentationTemplate.findMany({
        where: {
          OR: [{ isPublic: true }, { orgId: { in: orgIds } }],
          ...(input?.audience ? { audience: input.audience } : {}),
          ...(input?.type ? { type: input.type } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        select: { id: true, name: true, description: true, audience: true, type: true, structure: true },
      });
      const custom: TemplateSummary[] = rows
        .map((r) => {
          const outline = outlineFromStructure(r.structure);
          return {
            id: r.id,
            name: r.name,
            description: r.description ?? "",
            audience: r.audience,
            type: r.type,
            slideCount: outline.length,
            themeColor: null,
            builtIn: false,
            outline: outline.map((o) => o.title),
          };
        })
        .filter((t) => t.slideCount > 0);
      const builtIn = builtInTemplateSummaries().filter(
        (t) => (!input?.audience || t.audience === input.audience) && (!input?.type || t.type === input.type)
      );
      return [...builtIn, ...custom];
    }),

  exportPptx: writeProcedure.input(z.object({ id })).mutation(({ ctx, input }) => exportDeck(ctx, input.id, "pptx")),
  exportPdf: writeProcedure.input(z.object({ id })).mutation(({ ctx, input }) => exportDeck(ctx, input.id, "pdf")),
});

