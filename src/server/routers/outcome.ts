/**
 * Outcome tracking, the learning summary and the decision log.
 *
 * Recommendation, outcome and decision IDs in the input are always looked up
 * scoped to the authorized project.
 */
import { z } from "zod";
import { Prisma, type OutcomeStatus } from "@prisma/client";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { router, protectedProcedure, rateLimited } from "../trpc";
import { found, requireProjectAccess } from "../auth/access";
import { emitEvent } from "../events/bus";
import { computeProgress, OUTCOME_STATUSES } from "../ai/outcomes/tracker";
import { computeLearningSummary, learningContextFromSummary } from "../ai/outcomes/learning-engine";
import { evidenceLinksSchema } from "../ai/outcomes/decision-logger";

const writeProcedure = protectedProcedure.use(rateLimited(RATE_LIMITS.write));
const id = z.string().min(1).max(64);
const limit = z.number().int().min(1).max(100).default(25);
const statusEnum = z.enum(OUTCOME_STATUSES);
const metricValue = z.number().min(-1e12).max(1e12).nullable().optional();
const nullableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v === null || v.trim() === "" ? null : v.trim()));

function page<T extends { id: string }>(rows: T[], take: number) {
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

const outcomeFields = {
  status: statusEnum.optional(),
  metricName: nullableText(120),
  baselineValue: metricValue,
  currentValue: metricValue,
  targetValue: metricValue,
  notes: nullableText(5_000),
};

const outcomeSelect = {
  id: true,
  status: true,
  shippedAt: true,
  metricName: true,
  baselineValue: true,
  currentValue: true,
  targetValue: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  recommendation: { select: { id: true, title: true, impact: true, status: true, confidence: true } },
} satisfies Prisma.OutcomeTrackingSelect;

type OutcomeRow = Prisma.OutcomeTrackingGetPayload<{ select: typeof outcomeSelect }>;
const withProgress = (o: OutcomeRow) => ({ ...o, progress: computeProgress(o) });

function outcomeData(input: {
  status?: OutcomeStatus;
  metricName?: string | null;
  baselineValue?: number | null;
  currentValue?: number | null;
  targetValue?: number | null;
  notes?: string | null;
}, current: { status: OutcomeStatus; shippedAt: Date | null } | null) {
  const data: Prisma.OutcomeTrackingUncheckedUpdateInput = {};
  if (input.status !== undefined) {
    data.status = input.status;
    if (input.status !== "NOT_SHIPPED" && !current?.shippedAt) data.shippedAt = new Date();
  }
  if (input.metricName !== undefined) data.metricName = input.metricName;
  if (input.baselineValue !== undefined) data.baselineValue = input.baselineValue;
  if (input.currentValue !== undefined) data.currentValue = input.currentValue;
  if (input.targetValue !== undefined) data.targetValue = input.targetValue;
  if (input.notes !== undefined) data.notes = input.notes;
  return data;
}

export const outcomeRouter = router({
  /** Start (or update) outcome tracking for a recommendation in the project. */
  track: writeProcedure
    .input(z.object({ projectId: id, recommendationId: id, ...outcomeFields }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const rec = found(
        await ctx.prisma.recommendation.findFirst({
          where: { id: input.recommendationId, projectId: project.id },
          select: { id: true, status: true },
        }),
        "Recommendation"
      );
      const defaultStatus: OutcomeStatus = rec.status === "IMPLEMENTED" ? "SHIPPED" : "NOT_SHIPPED";
      // One row per recommendation (@@unique on recommendationId). If two first
      // calls race, the loser's create hits the unique key and updates instead.
      const updateExisting = async () => {
        const existing = await ctx.prisma.outcomeTracking.findUnique({
          where: { recommendationId: rec.id },
          select: { id: true, status: true, shippedAt: true },
        });
        if (!existing) return null;
        return ctx.prisma.outcomeTracking.update({
          where: { id: existing.id },
          data: outcomeData(input, existing),
          select: outcomeSelect,
        });
      };
      let row = await updateExisting();
      if (!row) {
        try {
          row = await ctx.prisma.outcomeTracking.create({
            data: {
              ...(outcomeData({ ...input, status: input.status ?? defaultStatus }, null) as Omit<Prisma.OutcomeTrackingUncheckedCreateInput, "recommendationId">),
              recommendationId: rec.id,
            },
            select: outcomeSelect,
          });
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
          row = found(await updateExisting(), "Outcome");
        }
      }
      await emitEvent({
        orgId: project.orgId,
        projectId: project.id,
        type: "outcome.updated",
        payload: { outcomeId: row.id, recommendationId: rec.id, status: row.status },
        actorUserId: ctx.user.id,
      });
      return withProgress(row);
    }),

  update: writeProcedure
    .input(z.object({ projectId: id, outcomeId: id, ...outcomeFields }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const existing = found(
        await ctx.prisma.outcomeTracking.findFirst({
          where: { id: input.outcomeId, recommendation: { projectId: project.id } },
          select: { id: true, status: true, shippedAt: true, recommendationId: true },
        }),
        "Outcome"
      );
      const row = await ctx.prisma.outcomeTracking.update({
        where: { id: existing.id },
        data: outcomeData(input, existing),
        select: outcomeSelect,
      });
      await emitEvent({
        orgId: project.orgId,
        projectId: project.id,
        type: "outcome.updated",
        payload: { outcomeId: row.id, recommendationId: existing.recommendationId, status: row.status },
        actorUserId: ctx.user.id,
      });
      return withProgress(row);
    }),

  getOutcomes: protectedProcedure
    .input(z.object({ projectId: id, status: statusEnum.optional(), limit, cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.outcomeTracking.findMany({
        where: { recommendation: { projectId: project.id }, ...(input.status ? { status: input.status } : {}) },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: outcomeSelect,
      });
      const { items, nextCursor } = page(rows, input.limit);
      return { items: items.map(withProgress), nextCursor };
    }),

  /** Recommendations that can be tracked or referenced from a decision. */
  recommendationOptions: protectedProcedure
    .input(z.object({ projectId: id, search: z.string().max(100).optional(), untrackedOnly: z.boolean().default(false), limit: z.number().int().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      return ctx.prisma.recommendation.findMany({
        where: {
          projectId: project.id,
          status: { not: "REJECTED" },
          ...(input.search?.trim() ? { title: { contains: input.search.trim(), mode: "insensitive" } } : {}),
          ...(input.untrackedOnly ? { outcomeTrackings: { none: {} } } : {}),
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: input.limit,
        select: { id: true, title: true, status: true, impact: true },
      });
    }),

  /**
   * Learning summary: what kinds of recommendations met their targets. `context`
   * is the same prompt-ready text the recommendation generator receives.
   */
  getLearnings: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const summary = await computeLearningSummary(project.id);
    return { ...summary, context: learningContextFromSummary(summary) };
  }),

  addDecisionLog: writeProcedure
    .input(
      z.object({
        projectId: id,
        decision: z.string().trim().min(1, "Describe the decision").max(2_000),
        reasoning: z.string().trim().min(1, "Reasoning is required").max(10_000),
        evidenceLinks: evidenceLinksSchema.default([]),
        recommendationId: id.nullish(),
        outcome: nullableText(2_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const rec = input.recommendationId
        ? found(
            await ctx.prisma.recommendation.findFirst({
              where: { id: input.recommendationId, projectId: project.id },
              select: { id: true },
            }),
            "Recommendation"
          )
        : null;
      return ctx.prisma.decisionLog.create({
        data: {
          projectId: project.id,
          userId: ctx.user.id,
          recommendationId: rec?.id ?? null,
          decision: input.decision,
          reasoning: input.reasoning,
          evidenceLinks: input.evidenceLinks,
          outcome: input.outcome ?? null,
        },
        select: { id: true, decision: true, reasoning: true, evidenceLinks: true, outcome: true, createdAt: true, recommendationId: true },
      });
    }),

  /** Record what happened after a decision (the decision author or any writer). */
  updateDecisionOutcome: writeProcedure
    .input(z.object({ projectId: id, decisionId: id, outcome: nullableText(2_000) }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const row = found(
        await ctx.prisma.decisionLog.findFirst({ where: { id: input.decisionId, projectId: project.id }, select: { id: true } }),
        "Decision"
      );
      return ctx.prisma.decisionLog.update({
        where: { id: row.id },
        data: { outcome: input.outcome ?? null },
        select: { id: true, outcome: true },
      });
    }),

  getDecisionLog: protectedProcedure
    .input(z.object({ projectId: id, recommendationId: id.optional(), limit, cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.decisionLog.findMany({
        where: { projectId: project.id, ...(input.recommendationId ? { recommendationId: input.recommendationId } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          decision: true,
          reasoning: true,
          evidenceLinks: true,
          outcome: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true } },
          recommendation: { select: { id: true, title: true } },
        },
      });
      return page(rows, input.limit);
    }),
});
