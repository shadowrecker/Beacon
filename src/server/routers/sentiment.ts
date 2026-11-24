/**
 * Sentiment and churn-risk API. Every procedure authorizes the project with
 * requireProjectAccess (outsiders get NOT_FOUND) and looks up alerts, snapshots
 * and assessments scoped to that project.
 */
import { AlertStatus, RiskLevel, SentimentPeriod, type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { can, requireProjectAccess } from "../auth/access";
import { llmProcedure, protectedProcedure, router } from "../trpc";
import { enqueue, QUEUE } from "../jobs/queues";
import { assertTokenBudget, BudgetExceededError } from "../usage/entitlements";
import { windowFor } from "../ai/sentiment/periods";
import { CHURN_METHODOLOGY, type RiskSignal } from "../ai/sentiment/churn";
import type { ThemeStat } from "../ai/sentiment/aggregate";

const id = z.string().min(1).max(64);
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);
const MAX_BACKFILL_MS = 2 * 366 * 24 * 3600 * 1000;

function themes(v: unknown): ThemeStat[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is ThemeStat => !!t && typeof t === "object" && typeof (t as ThemeStat).name === "string")
    .slice(0, 10)
    .map((t) => ({
      name: String(t.name).slice(0, 80),
      count: Number(t.count) || 0,
      positive: Number(t.positive) || 0,
      neutral: Number(t.neutral) || 0,
      negative: Number(t.negative) || 0,
      averageScore: Number(t.averageScore) || 0,
    }));
}

function signals(v: unknown): RiskSignal[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is RiskSignal => !!s && typeof s === "object" && typeof (s as RiskSignal).label === "string")
    .slice(0, 12)
    .map((s) => ({
      source: s.source === "ai" ? "ai" : "computed",
      label: String(s.label).slice(0, 120),
      detail: typeof s.detail === "string" ? s.detail.slice(0, 500) : null,
      weight: s.weight === "HIGH" || s.weight === "MEDIUM" ? s.weight : "LOW",
    }));
}

function strings(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((s) => s.slice(0, 300)) : [];
}

const snapshotSelect = {
  id: true,
  period: true,
  periodStart: true,
  periodEnd: true,
  customerSegment: true,
  overallScore: true,
  volume: true,
  positiveCount: true,
  neutralCount: true,
  negativeCount: true,
  riskLevel: true,
  topThemes: true,
  createdAt: true,
} as const;

type SnapshotRow = Prisma.SentimentSnapshotGetPayload<{ select: typeof snapshotSelect }>;
const shapeSnapshot = (s: SnapshotRow) => ({ ...s, topThemes: themes(s.topThemes) });

async function updateAlertStatus(
  ctx: Parameters<typeof requireProjectAccess>[0],
  input: { projectId: string; alertId: string },
  to: "ACKNOWLEDGED" | "RESOLVED"
) {
  const project = await requireProjectAccess(ctx, input.projectId, "project:write");
  const alert = await ctx.prisma.sentimentAlert.findFirst({
    where: { id: input.alertId, projectId: project.id },
    select: { id: true, status: true },
  });
  if (!alert) throw new TRPCError({ code: "NOT_FOUND", message: "Alert not found" });
  const allowedFrom: AlertStatus[] = to === "ACKNOWLEDGED" ? ["NEW"] : ["NEW", "ACKNOWLEDGED"];
  if (!allowedFrom.includes(alert.status)) return { id: alert.id, status: alert.status };
  const updated = await ctx.prisma.sentimentAlert.update({
    where: { id: alert.id },
    data: { status: to, ...(to === "RESOLVED" ? { resolvedAt: new Date() } : {}) },
    select: { id: true, status: true, resolvedAt: true },
  });
  return updated;
}

export const sentimentRouter = router({
  getSnapshots: protectedProcedure
    .input(
      z.object({
        projectId: id,
        period: z.enum(SentimentPeriod).default("WEEKLY"),
        segment: z.string().trim().min(1).max(60).default("all"),
        from: z.date().optional(),
        to: z.date().optional(),
        limit: limit(100, 52),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.sentimentSnapshot.findMany({
        where: {
          projectId: project.id,
          period: input.period,
          customerSegment: input.segment,
          ...(input.from || input.to ? { periodStart: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
        },
        orderBy: [{ periodStart: "desc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: snapshotSelect,
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map(shapeSnapshot);
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }),

  getCurrentSentiment: protectedProcedure
    .input(z.object({ projectId: id, period: z.enum(SentimentPeriod).default("WEEKLY") }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const [latest, openAlerts, lastRun] = await Promise.all([
        ctx.prisma.sentimentSnapshot.findMany({
          where: { projectId: project.id, period: input.period, customerSegment: "all" },
          orderBy: { periodStart: "desc" },
          take: 2,
          select: snapshotSelect,
        }),
        ctx.prisma.sentimentAlert.count({ where: { projectId: project.id, status: { in: ["NEW", "ACKNOWLEDGED"] } } }),
        ctx.prisma.jobRun.findFirst({
          where: { projectId: project.id, kind: "SENTIMENT" },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true, errorMessage: true, createdAt: true, completedAt: true, output: true },
        }),
      ]);
      const [current, previous] = latest;
      const out = (lastRun?.output ?? null) as Record<string, unknown> | null;
      return {
        current: current ? shapeSnapshot(current) : null,
        previous: previous ? { periodStart: previous.periodStart, overallScore: previous.overallScore, volume: previous.volume } : null,
        openAlerts,
        lastRun: lastRun
          ? {
              id: lastRun.id,
              status: lastRun.status,
              errorMessage: lastRun.errorMessage,
              createdAt: lastRun.createdAt,
              completedAt: lastRun.completedAt,
              totalChunks: typeof out?.totalChunks === "number" ? out.totalChunks : null,
              sampledChunks: typeof out?.sampledChunks === "number" ? out.sampledChunks : null,
              classifiedChunks: typeof out?.classifiedChunks === "number" ? out.classifiedChunks : null,
            }
          : null,
        permissions: { canWrite: can(project.role, "project:write"), canRun: can(project.role, "ai:run") },
      };
    }),

  getChurnPredictions: protectedProcedure
    .input(z.object({ projectId: id, riskLevel: z.enum(RiskLevel).optional(), limit: limit(100, 20), cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.churnPrediction.findMany({
        where: { projectId: project.id, ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}) },
        orderBy: [{ churnProbability: "desc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          runId: true,
          customerId: true,
          customerName: true,
          segment: true,
          churnProbability: true,
          riskLevel: true,
          confidence: true,
          signals: true,
          recommendations: true,
          methodology: true,
          createdAt: true,
        },
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((p) => ({
        ...p,
        methodology: p.methodology || CHURN_METHODOLOGY,
        signals: signals(p.signals),
        recommendations: strings(p.recommendations, 5),
      }));
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }),

  getAlerts: protectedProcedure
    .input(z.object({ projectId: id, status: z.enum(AlertStatus).optional(), limit: limit(100, 20), cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.sentimentAlert.findMany({
        where: { projectId: project.id, ...(input.status ? { status: input.status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, type: true, severity: true, title: true, description: true, status: true, dataPoints: true, createdAt: true, resolvedAt: true },
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((a) => {
        const dp = (a.dataPoints ?? {}) as Record<string, unknown>;
        return {
          id: a.id,
          type: a.type,
          severity: a.severity,
          title: a.title,
          description: a.description.slice(0, 2000),
          status: a.status,
          period: typeof dp.period === "string" ? dp.period : null,
          periodStart: typeof dp.periodStart === "string" ? dp.periodStart : null,
          createdAt: a.createdAt,
          resolvedAt: a.resolvedAt,
        };
      });
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }),

  acknowledgeAlert: protectedProcedure
    .input(z.object({ projectId: id, alertId: id }))
    .mutation(({ ctx, input }) => updateAlertStatus(ctx, input, "ACKNOWLEDGED")),

  resolveAlert: protectedProcedure
    .input(z.object({ projectId: id, alertId: id }))
    .mutation(({ ctx, input }) => updateAlertStatus(ctx, input, "RESOLVED")),

  runAnalysis: llmProcedure
    .input(z.object({ projectId: id, period: z.enum(SentimentPeriod), periodStart: z.date().optional() }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
      const now = new Date();
      const at = input.periodStart ?? now;
      if (at.getTime() > now.getTime()) throw new TRPCError({ code: "BAD_REQUEST", message: "The period cannot be in the future" });
      if (now.getTime() - at.getTime() > MAX_BACKFILL_MS) throw new TRPCError({ code: "BAD_REQUEST", message: "The period is too far in the past" });
      const periodStart = windowFor(input.period, at).start.toISOString();

      try {
        await assertTokenBudget(project.orgId);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: err.message });
        throw err;
      }

      // A double submit returns the run already in flight for the same period.
      const inFlight = await ctx.prisma.jobRun.findFirst({
        where: {
          projectId: project.id,
          kind: "SENTIMENT",
          status: { in: ["PENDING", "PROCESSING"] },
          createdAt: { gt: new Date(now.getTime() - 60 * 60_000) },
          AND: [{ input: { path: ["period"], equals: input.period } }, { input: { path: ["periodStart"], equals: periodStart } }],
        },
        select: { id: true },
      });
      if (inFlight) return { jobRunId: inFlight.id, periodStart, deduplicated: true };

      const run = await ctx.prisma.jobRun.create({
        data: {
          kind: "SENTIMENT",
          orgId: project.orgId,
          projectId: project.id,
          createdById: ctx.user.id,
          status: "PENDING",
          input: { period: input.period, periodStart },
        },
        select: { id: true },
      });
      await enqueue(QUEUE.SENTIMENT, { projectId: project.id, period: input.period, periodStart, jobRunId: run.id }, { jobId: `sent_manual_${run.id}` });
      return { jobRunId: run.id, periodStart, deduplicated: false };
    }),

  getSegmentBreakdown: protectedProcedure
    .input(z.object({ projectId: id, period: z.enum(SentimentPeriod).default("WEEKLY") }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const latest = await ctx.prisma.sentimentSnapshot.findFirst({
        where: { projectId: project.id, period: input.period, customerSegment: "all" },
        orderBy: { periodStart: "desc" },
        select: { periodStart: true, periodEnd: true },
      });
      if (!latest) return { periodStart: null, periodEnd: null, overall: null, segments: [] };
      const rows = await ctx.prisma.sentimentSnapshot.findMany({
        where: { projectId: project.id, period: input.period, periodStart: latest.periodStart },
        orderBy: [{ volume: "desc" }, { customerSegment: "asc" }],
        take: 25,
        select: snapshotSelect,
      });
      const shape = (s: SnapshotRow) => {
        const v = Math.max(1, s.volume);
        return {
          segment: s.customerSegment,
          overallScore: s.overallScore,
          riskLevel: s.riskLevel,
          volume: s.volume,
          positivePercent: Math.round((s.positiveCount / v) * 100),
          neutralPercent: Math.round((s.neutralCount / v) * 100),
          negativePercent: Math.round((s.negativeCount / v) * 100),
        };
      };
      const overall = rows.find((r) => r.customerSegment === "all");
      return {
        periodStart: latest.periodStart,
        periodEnd: latest.periodEnd,
        overall: overall ? shape(overall) : null,
        segments: rows.filter((r) => r.customerSegment !== "all").map(shape),
      };
    }),
});
