/**
 * Recommendations: generate from a synthesis (JobRun + job; clients poll
 * job.get), list, read, change status (emits recommendation.status_changed),
 * and feature briefs (stored on the recommendation).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router, protectedProcedure, llmProcedure } from "../trpc";
import { can, found, requireProjectAccess } from "../auth/access";
import { enqueue, QUEUE } from "../jobs/queues";
import { emitEvent } from "../events/bus";
import { getOrGenerateBrief, parseBrief, parseEvidence } from "../ai/brief";

const id = z.string().min(1).max(64);
const status = z.enum(["DRAFT", "ACCEPTED", "REJECTED", "IMPLEMENTED"]);
const impact = z.enum(["HIGH", "MEDIUM", "LOW"]);

const LIST_EVIDENCE_QUOTES = 3;

const listSelect = {
  id: true,
  title: true,
  description: true,
  impact: true,
  confidence: true,
  segments: true,
  evidence: true,
  status: true,
  synthesisId: true,
  runId: true,
  briefGeneratedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RecommendationSelect;

type Row = Prisma.RecommendationGetPayload<{ select: typeof listSelect }>;

function toItem(r: Row, quotes = LIST_EVIDENCE_QUOTES) {
  const evidence = parseEvidence(r.evidence);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    impact: r.impact,
    confidence: r.confidence,
    segments: r.segments,
    status: r.status,
    synthesisId: r.synthesisId,
    runId: r.runId,
    hasBrief: r.briefGeneratedAt !== null,
    briefGeneratedAt: r.briefGeneratedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    evidence: {
      themes: evidence?.themes ?? [],
      rationale: evidence?.rationale ?? null,
      quotes: (evidence?.quotes ?? []).slice(0, quotes),
      quoteCount: evidence?.quotes.length ?? 0,
    },
  };
}

export const recommendationRouter = router({
  /** Start a generation run; returns the JobRun id to poll with job.get. */
  generate: llmProcedure.input(z.object({ projectId: id, synthesisId: id.optional() })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
    const synthesis = input.synthesisId
      ? found(
          await ctx.prisma.synthesis.findFirst({ where: { id: input.synthesisId, projectId: project.id }, select: { id: true, status: true } }),
          "Synthesis"
        )
      : await ctx.prisma.synthesis.findFirst({
          where: { projectId: project.id, status: "READY" },
          orderBy: { completedAt: "desc" },
          select: { id: true, status: true },
        });
    if (!synthesis) throw new TRPCError({ code: "BAD_REQUEST", message: "Run a synthesis first; recommendations are based on its themes" });
    if (synthesis.status !== "READY") throw new TRPCError({ code: "BAD_REQUEST", message: "That synthesis hasn't finished yet" });

    const run = await ctx.prisma.jobRun.create({
      data: {
        kind: "RECOMMENDATIONS",
        orgId: project.orgId,
        projectId: project.id,
        createdById: ctx.user.id,
        status: "PENDING",
        input: { synthesisId: synthesis.id },
      },
      select: { id: true, status: true },
    });
    await enqueue(QUEUE.RECOMMENDATIONS, { jobRunId: run.id, projectId: project.id, synthesisId: synthesis.id }, { jobId: `rec_${run.id}` });
    return { jobRunId: run.id, synthesisId: synthesis.id, status: run.status };
  }),

  list: protectedProcedure
    .input(
      z.object({
        projectId: id,
        status: status.optional(),
        impact: impact.optional(),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.recommendation.findMany({
        where: {
          projectId: project.id,
          ...(input.status ? { status: input.status } : {}),
          ...(input.impact ? { impact: input.impact } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { confidence: "desc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: listSelect,
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map((r) => toItem(r)),
        nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
      };
    }),

  getById: protectedProcedure.input(z.object({ projectId: id, id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const r = found(
      await ctx.prisma.recommendation.findFirst({ where: { id: input.id, projectId: project.id }, select: { ...listSelect, brief: true } }),
      "Recommendation"
    );
    return { ...toItem(r, 20), brief: parseBrief(r.brief) };
  }),

  updateStatus: protectedProcedure.input(z.object({ projectId: id, id, status })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    const rec = found(
      await ctx.prisma.recommendation.findFirst({ where: { id: input.id, projectId: project.id }, select: { id: true, title: true, status: true } }),
      "Recommendation"
    );
    if (rec.status === input.status) return { id: rec.id, status: rec.status };
    const updated = await ctx.prisma.recommendation.update({
      where: { id: rec.id },
      data: { status: input.status },
      select: { id: true, status: true },
    });
    await emitEvent({
      orgId: project.orgId,
      projectId: project.id,
      type: "recommendation.status_changed",
      payload: { recommendationId: rec.id, title: rec.title, from: rec.status, to: input.status },
      actorUserId: ctx.user.id,
    });
    return updated;
  }),

  /** Return the stored brief, or generate one (always when regenerate is set). */
  generateBrief: llmProcedure
    .input(z.object({ projectId: id, id, regenerate: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rec = found(
        await ctx.prisma.recommendation.findFirst({
          where: { id: input.id, projectId: project.id },
          select: { id: true, brief: true },
        }),
        "Recommendation"
      );
      const stored = parseBrief(rec.brief);
      if (stored && !input.regenerate) return { brief: stored, generated: false };
      if (!can(project.role, "ai:run")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to generate briefs" });
      }
      const { brief, generated } = await getOrGenerateBrief(
        { recommendationId: rec.id, projectId: project.id, orgId: project.orgId },
        { regenerate: true }
      );
      return { brief, generated };
    }),
});
