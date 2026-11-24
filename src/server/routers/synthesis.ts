/**
 * Synthesis: start a run (row PENDING + job), list runs, read a run's themes
 * with their evidence, and poll status.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router, protectedProcedure, llmProcedure } from "../trpc";
import { found, requireProjectAccess } from "../auth/access";
import { enqueue, QUEUE } from "../jobs/queues";
import type { SynthesisOutput } from "../ai/types";

const id = z.string().min(1).max(64);
const synthesisType = z.enum(["THEMES", "PAIN_POINTS", "FEATURE_REQUESTS", "FULL"]);

const QUOTES_PER_THEME = 3;

function outputOf(value: Prisma.JsonValue | null): SynthesisOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as unknown as Partial<SynthesisOutput>;
  return o.version === 1 && Array.isArray(o.themes) ? (o as SynthesisOutput) : null;
}

const citationSelect = {
  id: true,
  quote: true,
  relevanceScore: true,
  chunk: { select: { id: true, position: true, documentId: true, document: { select: { title: true } } } },
} satisfies Prisma.CitationSelect;

type CitationRow = Prisma.CitationGetPayload<{ select: typeof citationSelect }>;

function toQuote(c: CitationRow) {
  return {
    id: c.id,
    quote: c.quote,
    relevanceScore: c.relevanceScore,
    chunkId: c.chunk.id,
    position: c.chunk.position,
    documentId: c.chunk.documentId,
    documentTitle: c.chunk.document.title,
  };
}

export const synthesisRouter = router({
  run: llmProcedure.input(z.object({ projectId: id, type: synthesisType.default("FULL") })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
    const running = await ctx.prisma.synthesis.findFirst({
      where: { projectId: project.id, status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true, status: true },
    });
    if (running) return { id: running.id, status: running.status, alreadyRunning: true };

    const ready = await ctx.prisma.document.count({ where: { projectId: project.id, status: "READY" } });
    if (ready === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Add at least one document and wait for it to finish processing first" });
    }
    const synthesis = await ctx.prisma.synthesis.create({
      data: { projectId: project.id, type: input.type, status: "PENDING", createdById: ctx.user.id },
      select: { id: true, status: true },
    });
    await enqueue(QUEUE.SYNTHESIS, { synthesisId: synthesis.id }, { jobId: `syn_${synthesis.id}` });
    return { id: synthesis.id, status: synthesis.status, alreadyRunning: false };
  }),

  list: protectedProcedure
    .input(z.object({ projectId: id, limit: z.number().int().min(1).max(50).default(10), cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.synthesis.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          type: true,
          status: true,
          errorMessage: true,
          output: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          _count: { select: { themes: true } },
        },
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map((s) => {
          const out = outputOf(s.output);
          return {
            id: s.id,
            type: s.type,
            status: s.status,
            errorMessage: s.errorMessage,
            createdAt: s.createdAt,
            startedAt: s.startedAt,
            completedAt: s.completedAt,
            themeCount: s._count.themes,
            documentsAnalyzed: out?.documentsAnalyzed ?? null,
            skippedCount: out ? out.skippedDocuments.length : null,
          };
        }),
        nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
      };
    }),

  getById: protectedProcedure.input(z.object({ projectId: id, id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const s = found(
      await ctx.prisma.synthesis.findFirst({
        where: { id: input.id, projectId: project.id },
        select: {
          id: true,
          type: true,
          status: true,
          errorMessage: true,
          output: true,
          modelUsed: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          themes: {
            orderBy: { confidenceScore: "desc" },
            take: 50,
            select: {
              id: true,
              name: true,
              description: true,
              sentiment: true,
              confidenceScore: true,
              _count: { select: { citations: true } },
              citations: { orderBy: { relevanceScore: "desc" }, take: QUOTES_PER_THEME, select: citationSelect },
            },
          },
        },
      }),
      "Synthesis"
    );
    const out = outputOf(s.output);
    const stats = new Map((out?.themes ?? []).map((t, i) => [t.themeId, { ...t, order: i }]));
    const themes = s.themes
      .map((t) => {
        const st = stats.get(t.id);
        const theme = {
          id: t.id,
          name: t.name,
          description: t.description,
          sentiment: t.sentiment,
          confidenceScore: t.confidenceScore,
          citationCount: t._count.citations,
          frequency: st?.frequency ?? null,
          insightCount: st?.insightCount ?? null,
          severity: st?.severity ?? null,
          priorityScore: st?.priorityScore ?? null,
          productAreas: st?.productAreas ?? [],
          segments: st?.segments ?? [],
          topQuotes: t.citations.map(toQuote),
        };
        return { theme, order: st?.order ?? Number.MAX_SAFE_INTEGER };
      })
      .sort((a, b) => a.order - b.order || b.theme.confidenceScore - a.theme.confidenceScore)
      .map((x) => x.theme);
    return {
      id: s.id,
      type: s.type,
      status: s.status,
      errorMessage: s.errorMessage,
      modelUsed: s.modelUsed,
      createdAt: s.createdAt,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      summary: out
        ? {
            documentsConsidered: out.documentsConsidered,
            documentsAnalyzed: out.documentsAnalyzed,
            documentsNotIncluded: out.documentsNotIncluded,
            insightCount: out.insightCount,
            skippedDocuments: out.skippedDocuments,
            partialDocuments: out.partialDocuments,
          }
        : null,
      themes,
    };
  }),

  /** Lightweight status for polling a run. */
  getStatus: protectedProcedure.input(z.object({ projectId: id, id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    return found(
      await ctx.prisma.synthesis.findFirst({
        where: { id: input.id, projectId: project.id },
        select: { id: true, status: true, errorMessage: true, startedAt: true, completedAt: true },
      }),
      "Synthesis"
    );
  }),

  /** All evidence for one theme, paginated. */
  themeCitations: protectedProcedure
    .input(z.object({ projectId: id, themeId: id, limit: z.number().int().min(1).max(50).default(20), cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const theme = found(
        await ctx.prisma.theme.findFirst({
          where: { id: input.themeId, synthesis: { projectId: project.id } },
          select: { id: true, name: true },
        }),
        "Theme"
      );
      const rows = await ctx.prisma.citation.findMany({
        where: { themeId: theme.id },
        orderBy: [{ relevanceScore: "desc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: citationSelect,
      });
      const page = rows.slice(0, input.limit);
      return {
        theme,
        items: page.map(toQuote),
        nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
      };
    }),
});
