/**
 * Usage analytics imports and theme <-> metric correlation.
 *
 * - importData: CSV (parsed server-side, in the request) or the org's connected
 *   Amplitude / Mixpanel integration (queued on QUEUE.IMPORTS). An
 *   integrationId in the input must belong to the project's org; credentials
 *   are always resolved from that org server-side.
 * - runCorrelation: JobRun(kind CORRELATION) + QUEUE.CORRELATION; the client
 *   polls job.get({ id }).
 * - Lists are paginated and never return raw import blobs.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma, type AnalyticsSource } from "@prisma/client";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { router, protectedProcedure, llmProcedure, outboundProcedure, rateLimited } from "../trpc";
import { found, requireProjectAccess } from "../auth/access";
import { enqueue, QUEUE } from "../jobs/queues";
import { getLatestThemes } from "../synthesis/queries";
import {
  ANALYTICS_SOURCE_LABEL,
  AnalyticsImportError,
  analyticsImportJobInputSchema,
  loadProjectSeries,
  MAX_CSV_BYTES,
  parseAnalyticsCsv,
  saveAnalyticsImport,
  seriesKey,
  validateRange,
  type AnalyticsSummary,
} from "../ai/analytics/importer";
import { loadThemeMentions } from "../ai/analytics/correlator";

const writeProcedure = protectedProcedure.use(rateLimited(RATE_LIMITS.write));
const id = z.string().min(1).max(64);
const limit = z.number().int().min(1).max(100).default(25);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function page<T extends { id: string }>(rows: T[], take: number) {
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

const importInput = z.discriminatedUnion("source", [
  z.object({
    projectId: id,
    source: z.literal("CSV"),
    filename: z.string().max(200).optional(),
    csv: z.string().min(1).max(MAX_CSV_BYTES),
  }),
  z.object({
    projectId: id,
    source: z.enum(["AMPLITUDE", "MIXPANEL"]),
    integrationId: id.optional(),
    startDate: date,
    endDate: date,
  }),
]);

type ImportResponse =
  | {
      mode: "done";
      import: { id: string; source: AnalyticsSource; importedAt: Date };
      summary: AnalyticsSummary;
      skipped: Array<{ row: number; reason: string }>;
    }
  | { mode: "queued"; jobRunId: string; status: "PENDING" | "PROCESSING"; alreadyRunning: boolean };

interface ImportRow {
  id: string;
  source: AnalyticsSource;
  importedAt: Date;
  integrationId: string | null;
  summary: AnalyticsSummary | null;
}

export const analyticsRouter = router({
  /** Connected analytics integrations in the project's org (never credentials). */
  listSources: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const rows = await ctx.prisma.integration.findMany({
      where: { orgId: project.orgId, provider: { in: ["AMPLITUDE", "MIXPANEL"] } },
      select: { id: true, provider: true, status: true, lastSyncAt: true },
      orderBy: { provider: "asc" },
    });
    return rows.map((r) => ({ ...r, connected: r.status === "CONNECTED" }));
  }),

  /**
   * - CSV: parsed and stored in the request (bounded) -> { mode: "done", ... }.
   * - Amplitude / Mixpanel: an ANALYTICS_IMPORT JobRun is queued on
   *   QUEUE.IMPORTS -> { mode: "queued", jobRunId }; poll job.get({ id }).
   */
  importData: outboundProcedure.input(importInput).mutation(async ({ ctx, input }): Promise<ImportResponse> => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");

    if (input.source === "CSV") {
      try {
        const parsed = parseAnalyticsCsv(input.csv);
        const result = await saveAnalyticsImport(ctx.prisma, {
          projectId: project.id,
          source: "CSV",
          integrationId: null,
          points: parsed.points,
          skipped: parsed.skipped.length,
          truncated: parsed.truncated,
        });
        return {
          mode: "done",
          import: { id: result.importId, source: result.source, importedAt: result.importedAt },
          summary: result.summary,
          skipped: parsed.skipped.slice(0, 50),
        };
      } catch (err) {
        if (err instanceof AnalyticsImportError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
    }

    // Integration import: the integration must belong to this project's org.
    const integration = found(
      await ctx.prisma.integration.findFirst({
        where: {
          orgId: project.orgId,
          provider: input.source,
          ...(input.integrationId ? { id: input.integrationId } : {}),
        },
        select: { id: true, provider: true, status: true },
      }),
      "Integration"
    );
    const label = ANALYTICS_SOURCE_LABEL[input.source];
    if (integration.status !== "CONNECTED") {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${label} is not connected` });
    }
    let range;
    try {
      range = validateRange({ start: input.startDate, end: input.endDate });
    } catch (err) {
      if (err instanceof AnalyticsImportError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
      throw err;
    }
    const params = analyticsImportJobInputSchema.parse({
      source: input.source,
      integrationId: integration.id,
      startDate: range.start,
      endDate: range.end,
    });

    const inFlight = await ctx.prisma.jobRun.findFirst({
      where: {
        projectId: project.id,
        kind: "ANALYTICS_IMPORT",
        status: { in: ["PENDING", "PROCESSING"] },
        input: { path: ["integrationId"], equals: integration.id },
      },
      select: { id: true, status: true },
    });
    if (inFlight) {
      return { mode: "queued", jobRunId: inFlight.id, status: inFlight.status as "PENDING" | "PROCESSING", alreadyRunning: true };
    }
    const run = await ctx.prisma.jobRun.create({
      data: {
        kind: "ANALYTICS_IMPORT",
        orgId: project.orgId,
        projectId: project.id,
        createdById: ctx.user.id,
        status: "PENDING",
        input: params as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await enqueue(QUEUE.IMPORTS, { jobRunId: run.id }, { jobId: `import_${run.id}` });
    return { mode: "queued", jobRunId: run.id, status: "PENDING", alreadyRunning: false };
  }),

  /** Imports with their summaries (the raw points are never returned here). */
  getImports: protectedProcedure
    .input(z.object({ projectId: id, limit, cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      let cursorCond = Prisma.empty;
      if (input.cursor) {
        const c = found(
          await ctx.prisma.analyticsImport.findFirst({ where: { id: input.cursor, projectId: project.id }, select: { id: true, importedAt: true } }),
          "Import"
        );
        cursorCond = Prisma.sql`AND (a."importedAt", a.id) < (${c.importedAt}, ${c.id})`;
      }
      const rows = await ctx.prisma.$queryRaw<ImportRow[]>`
        SELECT a.id, a.source::text AS source, a."importedAt", a."integrationId", a.data->'summary' AS summary
        FROM analytics_imports a
        WHERE a."projectId" = ${project.id} ${cursorCond}
        ORDER BY a."importedAt" DESC, a.id DESC
        LIMIT ${input.limit + 1}`;
      return page(rows, input.limit);
    }),

  deleteImport: writeProcedure.input(z.object({ projectId: id, importId: id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    const row = found(
      await ctx.prisma.analyticsImport.findFirst({ where: { id: input.importId, projectId: project.id }, select: { id: true } }),
      "Import"
    );
    await ctx.prisma.analyticsImport.delete({ where: { id: row.id } });
    return { id: row.id };
  }),

  /** Metric series available from the most recent imports. */
  listSeries: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const { series } = await loadProjectSeries(project.id, { maxSeries: 100 });
    return series.map((s) => {
      const dates = [...s.values.keys()].sort();
      const last = dates[dates.length - 1];
      return {
        feature: s.feature,
        metric: s.metric,
        points: s.values.size,
        start: dates[0] ?? null,
        end: last ?? null,
        latestValue: last ? s.values.get(last)! : null,
      };
    });
  }),

  /** Themes of the latest synthesis (for overlaying mentions on a metric). */
  listThemes: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const { themes } = await getLatestThemes(project.id, { limit: 50, quotesPerTheme: 0 });
    return themes.map((t) => ({ id: t.id, name: t.name, sentiment: t.sentiment, citationCount: t.citationCount }));
  }),

  /** One metric series (daily), optionally with a theme's daily mention counts. */
  getSeries: protectedProcedure
    .input(z.object({ projectId: id, feature: z.string().min(1).max(200), metric: z.string().min(1).max(100), themeId: id.optional() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const { series } = await loadProjectSeries(project.id, { maxSeries: 100 });
      const s = found(series.find((x) => x.key === seriesKey(input.feature, input.metric)), "Metric series");
      const points = [...s.values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, value]) => ({ date: d, value }));
      let mentions: Array<{ date: string; count: number }> | null = null;
      let theme: { id: string; name: string } | null = null;
      if (input.themeId) {
        theme = found(
          await ctx.prisma.theme.findFirst({ where: { id: input.themeId, synthesis: { projectId: project.id } }, select: { id: true, name: true } }),
          "Theme"
        );
        const m = await loadThemeMentions(project.id, [theme.id]);
        const byDate = m.byTheme.get(theme.id) ?? new Map<string, number>();
        mentions = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, count]) => ({ date: d, count }));
      }
      return { feature: s.feature, metric: s.metric, points, theme, mentions };
    }),

  runCorrelation: llmProcedure.input(z.object({ projectId: id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
    const inFlight = await ctx.prisma.jobRun.findFirst({
      where: { projectId: project.id, kind: "CORRELATION", status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true, status: true },
    });
    if (inFlight) return { jobRunId: inFlight.id, status: inFlight.status, alreadyRunning: true };

    const [themes, importCount] = await Promise.all([
      getLatestThemes(project.id, { limit: 1, quotesPerTheme: 0 }),
      ctx.prisma.analyticsImport.count({ where: { projectId: project.id } }),
    ]);
    if (themes.themes.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Run a synthesis first: correlation needs customer themes" });
    }
    if (importCount === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Import usage data before running a correlation" });
    }
    const run = await ctx.prisma.jobRun.create({
      data: {
        kind: "CORRELATION",
        orgId: project.orgId,
        projectId: project.id,
        createdById: ctx.user.id,
        status: "PENDING",
        input: { synthesisId: themes.synthesisId },
      },
      select: { id: true, status: true },
    });
    await enqueue(QUEUE.CORRELATION, { jobRunId: run.id, projectId: project.id }, { jobId: `corr_${run.id}` });
    return { jobRunId: run.id, status: run.status, alreadyRunning: false };
  }),

  /** The most recent correlation run (for resuming polling after a reload). */
  latestRun: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    return ctx.prisma.jobRun.findFirst({
      where: { projectId: project.id, kind: "CORRELATION" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, output: true, errorMessage: true, createdAt: true, completedAt: true },
    });
  }),

  getCorrelations: protectedProcedure
    .input(
      z.object({
        projectId: id,
        themeId: id.optional(),
        direction: z.enum(["positive", "negative", "neutral"]).optional(),
        limit,
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.usageCorrelation.findMany({
        where: {
          projectId: project.id,
          ...(input.themeId ? { themeId: input.themeId } : {}),
          ...(input.direction ? { direction: input.direction } : {}),
        },
        // Most negative first when browsing negative correlations; strongest positive otherwise.
        orderBy: [{ correlationScore: input.direction === "negative" ? "asc" : "desc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          featureName: true,
          usageMetric: true,
          correlationScore: true,
          direction: true,
          insight: true,
          updatedAt: true,
          theme: { select: { id: true, name: true, sentiment: true } },
        },
      });
      return page(rows, input.limit);
    }),
});
