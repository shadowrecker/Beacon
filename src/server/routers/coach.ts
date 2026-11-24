/**
 * AI coach API. Insights and sessions are personal: every lookup is scoped to
 * the caller's user ID, and project-scoped calls also require project access.
 * Coaching runs asynchronously: requestCoaching only creates a JobRun and
 * enqueues it (the client polls job.get).
 */
import { CoachInsightStatus, type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { requireProjectAccess } from "../auth/access";
import { llmProcedure, protectedProcedure, router } from "../trpc";
import { enqueue, QUEUE } from "../jobs/queues";
import { assertTokenBudget, BudgetExceededError } from "../usage/entitlements";
import { buildCoachContext } from "../ai/coach/context";

const id = z.string().min(1).max(64);
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);

/** Insight filter that excludes projects the caller can no longer access. */
function accessibleInsights(userId: string): Prisma.CoachInsightWhereInput {
  return {
    userId,
    OR: [{ projectId: null }, { project: { organization: { members: { some: { userId, joinedAt: { not: null } } } } } }],
  };
}

function evidenceOf(v: unknown) {
  const e = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").slice(0, 5).map((s) => s.slice(0, 200)) : []);
  return {
    rationale: typeof e.rationale === "string" ? e.rationale.slice(0, 800) : null,
    actionItems: list(e.actionItems),
    framework: typeof e.framework === "string" ? e.framework.slice(0, 60) : null,
    trigger: typeof e.trigger === "string" ? e.trigger : null,
  };
}

async function setInsightStatus(
  ctx: Parameters<typeof requireProjectAccess>[0] & { user: { id: string } },
  insightId: string,
  status: "DISMISSED" | "ACTIONED"
) {
  const insight = await ctx.prisma.coachInsight.findFirst({
    where: { id: insightId, userId: ctx.user.id },
    select: { id: true, projectId: true },
  });
  if (!insight) throw new TRPCError({ code: "NOT_FOUND", message: "Insight not found" });
  if (insight.projectId) await requireProjectAccess(ctx, insight.projectId, "project:read");
  return ctx.prisma.coachInsight.update({ where: { id: insight.id }, data: { status }, select: { id: true, status: true } });
}

export const coachRouter = router({
  getInsights: protectedProcedure
    .input(
      z.object({
        projectId: id.optional(),
        status: z.enum(CoachInsightStatus).optional(),
        /** "open" = NEW or SEEN (the default inbox view). */
        view: z.enum(["open", "all"]).default("open"),
        limit: limit(50, 20),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const scope: Prisma.CoachInsightWhereInput = input.projectId
        ? { userId, projectId: (await requireProjectAccess(ctx, input.projectId, "project:read")).id }
        : accessibleInsights(userId);
      const statusFilter: Prisma.CoachInsightWhereInput = input.status
        ? { status: input.status }
        : input.view === "open"
          ? { status: { in: ["NEW", "SEEN"] } }
          : {};
      const [rows, newCount] = await Promise.all([
        ctx.prisma.coachInsight.findMany({
          where: { AND: [scope, statusFilter] },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            type: true,
            priority: true,
            status: true,
            title: true,
            message: true,
            evidence: true,
            createdAt: true,
            project: { select: { id: true, name: true } },
          },
        }),
        ctx.prisma.coachInsight.count({ where: { AND: [scope, { status: "NEW" }] } }),
      ]);
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((r) => ({
        id: r.id,
        type: r.type,
        priority: r.priority,
        status: r.status,
        title: r.title,
        message: r.message.slice(0, 2_000),
        createdAt: r.createdAt,
        project: r.project,
        ...evidenceOf(r.evidence),
      }));
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null, newCount };
    }),

  /** Mark the caller's NEW insights as SEEN once they have been displayed. */
  markSeen: protectedProcedure.input(z.object({ insightIds: z.array(id).min(1).max(100) })).mutation(async ({ ctx, input }) => {
    const res = await ctx.prisma.coachInsight.updateMany({
      where: { AND: [accessibleInsights(ctx.user.id), { id: { in: input.insightIds }, status: "NEW" }] },
      data: { status: "SEEN" },
    });
    return { updated: res.count };
  }),

  dismissInsight: protectedProcedure.input(z.object({ insightId: id })).mutation(({ ctx, input }) => setInsightStatus(ctx, input.insightId, "DISMISSED")),

  actionInsight: protectedProcedure.input(z.object({ insightId: id })).mutation(({ ctx, input }) => setInsightStatus(ctx, input.insightId, "ACTIONED")),

  requestCoaching: llmProcedure.input(z.object({ projectId: id })).mutation(async ({ ctx, input }) => {
    // ai:run is MEMBER and above; VIEWERs get FORBIDDEN.
    const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
    try {
      await assertTokenBudget(project.orgId);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: err.message });
      throw err;
    }
    const inFlight = await ctx.prisma.jobRun.findFirst({
      where: {
        projectId: project.id,
        kind: "COACHING",
        createdById: ctx.user.id,
        status: { in: ["PENDING", "PROCESSING"] },
        createdAt: { gt: new Date(Date.now() - 60 * 60_000) },
      },
      select: { id: true },
    });
    if (inFlight) return { jobRunId: inFlight.id, deduplicated: true };
    const run = await ctx.prisma.jobRun.create({
      data: { kind: "COACHING", orgId: project.orgId, projectId: project.id, createdById: ctx.user.id, status: "PENDING", input: { trigger: "manual" } },
      select: { id: true },
    });
    await enqueue(QUEUE.COACHING, { jobRunId: run.id }, { jobId: `coach_manual_${run.id}` });
    return { jobRunId: run.id, deduplicated: false };
  }),

  getCoachingHistory: protectedProcedure
    .input(z.object({ projectId: id.optional(), limit: limit(50, 10), cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const where: Prisma.CoachSessionWhereInput = { userId: ctx.user.id };
      if (input.projectId) {
        const project = await requireProjectAccess(ctx, input.projectId, "project:read");
        where.context = { path: ["projectId"], equals: project.id };
      }
      const rows = await ctx.prisma.coachSession.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, context: true, recommendations: true, createdAt: true },
      });
      // Sessions for projects the caller can no longer access are hidden.
      const projectIds = [
        ...new Set(rows.map((r) => (r.context as Record<string, unknown> | null)?.projectId).filter((p): p is string => typeof p === "string")),
      ];
      const visible = new Map(
        (
          await ctx.prisma.project.findMany({
            where: { id: { in: projectIds }, organization: { members: { some: { userId: ctx.user.id, joinedAt: { not: null } } } } },
            select: { id: true, name: true },
          })
        ).map((p) => [p.id, p])
      );
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).flatMap((r) => {
        const c = (r.context ?? {}) as Record<string, unknown>;
        const project = typeof c.projectId === "string" ? visible.get(c.projectId) : undefined;
        if (!project) return [];
        const recs = Array.isArray(r.recommendations) ? (r.recommendations as Array<Record<string, unknown>>) : [];
        return [
          {
            id: r.id,
            createdAt: r.createdAt,
            project,
            trigger: typeof c.trigger === "string" ? c.trigger : null,
            summary: typeof c.summary === "string" ? c.summary.slice(0, 600) : null,
            ignoredThemes: Array.isArray(c.ignoredThemes) ? (c.ignoredThemes as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 8) : [],
            insights: recs.slice(0, 5).map((x) => ({
              title: typeof x.title === "string" ? x.title.slice(0, 120) : "",
              type: typeof x.type === "string" ? x.type : null,
              priority: typeof x.priority === "string" ? x.priority : null,
            })),
          },
        ];
      });
      return { items, nextCursor: hasMore ? rows[input.limit - 1].id : null };
    }),

  getActivityAnalysis: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const context = await buildCoachContext(project.id);
    if (!context) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
    return {
      generatedAt: context.generatedAt,
      counts: context.counts,
      latestSynthesisAt: context.latestSynthesisAt,
      ignoredThemes: context.ignoredThemes,
      decisionPatterns: context.decisionPatterns,
      activity: context.activity,
      canRequestCoaching: project.role !== "VIEWER",
    };
  }),
});
