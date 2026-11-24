/**
 * Roadmaps, roadmap items, imports and gap analysis.
 *
 * Every procedure authorizes the project first, then looks up roadmaps and items
 * scoped to that project (never by bare ID), so a foreign roadmapId/itemId is
 * indistinguishable from a nonexistent one.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { RATE_LIMITS } from "@/lib/rate-limit";
import type { DbClient } from "@/lib/db";
import { router, protectedProcedure, llmProcedure, outboundProcedure, rateLimited } from "../trpc";
import { found, requireProjectAccess } from "../auth/access";
import { enqueue, QUEUE } from "../jobs/queues";
import { getLatestThemes } from "../synthesis/queries";
import {
  ImportError,
  MAX_CSV_BYTES,
  parseRoadmapCsv,
  ROADMAP_ITEM_PRIORITIES,
  ROADMAP_ITEM_STATUSES,
  roadmapImportJobInputSchema,
  runRoadmapImport,
  SOURCE_LABEL,
  type RoadmapImportResult,
} from "../ai/roadmap/importer";
import { gapOutputSchema } from "../ai/roadmap/gap-analyzer";

const writeProcedure = protectedProcedure.use(rateLimited(RATE_LIMITS.write));

const id = z.string().min(1).max(64);
const limit = z.number().int().min(1).max(100).default(25);
const statusEnum = z.enum(ROADMAP_ITEM_STATUSES);
const priorityEnum = z.enum(ROADMAP_ITEM_PRIORITIES);
const optionalText = (max: number) =>
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

async function roadmapInProject(db: DbClient, roadmapId: string, projectId: string) {
  return found(
    await db.roadmap.findFirst({ where: { id: roadmapId, projectId }, select: { id: true, name: true, metadata: true } }),
    "Roadmap"
  );
}

const itemSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  quarter: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RoadmapItemSelect;

const importInput = z.discriminatedUnion("source", [
  z.object({
    projectId: id,
    source: z.literal("CSV"),
    roadmapId: id.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    filename: z.string().max(200).optional(),
    csv: z.string().min(1).max(MAX_CSV_BYTES),
  }),
  z.object({
    projectId: id,
    source: z.literal("LINEAR"),
    roadmapId: id.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    teamId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/).optional(),
  }),
  z.object({
    projectId: id,
    source: z.literal("JIRA"),
    roadmapId: id.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    projectKey: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z][A-Z0-9_]{1,9}$/, "Enter a Jira project key such as PROD"),
  }),
  z.object({
    projectId: id,
    source: z.literal("NOTION"),
    roadmapId: id.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    databaseId: z
      .string()
      .trim()
      .regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i, "Enter a Notion database ID"),
  }),
  z.object({
    projectId: id,
    source: z.literal("PRODUCTBOARD"),
    roadmapId: id.optional(),
    name: z.string().trim().min(1).max(120).optional(),
  }),
]);


const lastImportSchema = z.object({
  at: z.string(),
  source: z.string().optional(),
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  truncated: z.boolean(),
});

type ImportResponse =
  | ({ mode: "done" } & RoadmapImportResult)
  | { mode: "queued"; jobRunId: string; status: "PENDING" | "PROCESSING"; alreadyRunning: boolean };

function gapStats(output: Prisma.JsonValue | null) {
  const parsed = gapOutputSchema.safeParse(output);
  return parsed.success ? parsed.data.stats : null;
}

export const roadmapRouter = router({
  list: protectedProcedure
    .input(z.object({ projectId: id, limit, cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.roadmap.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, name: true, source: true, importedAt: true, createdAt: true, _count: { select: { items: true } } },
      });
      const { items, nextCursor } = page(rows, input.limit);
      return {
        items: items.map((r) => ({
          id: r.id,
          name: r.name,
          source: r.source,
          importedAt: r.importedAt,
          createdAt: r.createdAt,
          itemCount: r._count.items,
        })),
        nextCursor,
      };
    }),

  create: writeProcedure
    .input(z.object({ projectId: id, name: z.string().trim().min(1, "Name is required").max(120) }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      return ctx.prisma.roadmap.create({
        data: { projectId: project.id, name: input.name, source: "MANUAL" },
        select: { id: true, name: true, source: true, createdAt: true },
      });
    }),

  rename: writeProcedure
    .input(z.object({ projectId: id, roadmapId: id, name: z.string().trim().min(1, "Name is required").max(120) }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const roadmap = await roadmapInProject(ctx.prisma, input.roadmapId, project.id);
      return ctx.prisma.roadmap.update({ where: { id: roadmap.id }, data: { name: input.name }, select: { id: true, name: true } });
    }),

  delete: writeProcedure.input(z.object({ projectId: id, roadmapId: id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    const roadmap = await roadmapInProject(ctx.prisma, input.roadmapId, project.id);
    await ctx.prisma.roadmap.delete({ where: { id: roadmap.id } });
    return { id: roadmap.id };
  }),

  /** One roadmap with a page of its items (infinite-query compatible). */
  get: protectedProcedure
    .input(
      z.object({
        projectId: id,
        roadmapId: id,
        limit: z.number().int().min(1).max(100).default(50),
        cursor: id.nullish(),
        status: statusEnum.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const roadmap = found(
        await ctx.prisma.roadmap.findFirst({
          where: { id: input.roadmapId, projectId: project.id },
          select: { id: true, name: true, source: true, importedAt: true, createdAt: true, metadata: true },
        }),
        "Roadmap"
      );
      const [rows, statusCounts] = await Promise.all([
        ctx.prisma.roadmapItem.findMany({
          where: { roadmapId: roadmap.id, ...(input.status ? { status: input.status } : {}) },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: itemSelect,
        }),
        ctx.prisma.roadmapItem.groupBy({ by: ["status"], where: { roadmapId: roadmap.id }, _count: { _all: true } }),
      ]);
      const meta = (roadmap.metadata ?? {}) as { importSource?: string; lastImport?: unknown };
      const lastImport = lastImportSchema.safeParse(meta.lastImport);
      const counts = Object.fromEntries(ROADMAP_ITEM_STATUSES.map((s) => [s, 0])) as Record<(typeof ROADMAP_ITEM_STATUSES)[number], number>;
      for (const c of statusCounts) counts[c.status] = c._count._all;
      const { items, nextCursor } = page(rows, input.limit);
      return {
        roadmap: {
          id: roadmap.id,
          name: roadmap.name,
          source: roadmap.source,
          importedAt: roadmap.importedAt,
          createdAt: roadmap.createdAt,
          // Legacy rows (before the CSV source existed) recorded CSV imports here.
          importSource: typeof meta.importSource === "string" ? meta.importSource : null,
          lastImport: lastImport.success ? lastImport.data : null,
          itemCount: Object.values(counts).reduce((a, b) => a + b, 0),
          statusCounts: counts,
        },
        items,
        nextCursor,
      };
    }),

  addItem: writeProcedure
    .input(
      z.object({
        projectId: id,
        roadmapId: id,
        title: z.string().trim().min(1, "Title is required").max(300),
        description: optionalText(5_000),
        status: statusEnum.default("PLANNED"),
        priority: priorityEnum.default("P2"),
        quarter: optionalText(50),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const roadmap = await roadmapInProject(ctx.prisma, input.roadmapId, project.id);
      return ctx.prisma.roadmapItem.create({
        data: {
          roadmapId: roadmap.id,
          title: input.title,
          description: input.description ?? null,
          status: input.status,
          priority: input.priority,
          quarter: input.quarter ?? null,
        },
        select: itemSelect,
      });
    }),

  updateItem: writeProcedure
    .input(
      z.object({
        projectId: id,
        itemId: id,
        title: z.string().trim().min(1, "Title is required").max(300).optional(),
        description: optionalText(5_000),
        status: statusEnum.optional(),
        priority: priorityEnum.optional(),
        quarter: optionalText(50),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const item = found(
        await ctx.prisma.roadmapItem.findFirst({
          where: { id: input.itemId, roadmap: { projectId: project.id } },
          select: { id: true },
        }),
        "Roadmap item"
      );
      return ctx.prisma.roadmapItem.update({
        where: { id: item.id },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.quarter !== undefined ? { quarter: input.quarter } : {}),
        },
        select: itemSelect,
      });
    }),

  deleteItem: writeProcedure.input(z.object({ projectId: id, itemId: id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    const item = found(
      await ctx.prisma.roadmapItem.findFirst({
        where: { id: input.itemId, roadmap: { projectId: project.id } },
        select: { id: true },
      }),
      "Roadmap item"
    );
    await ctx.prisma.roadmapItem.delete({ where: { id: item.id } });
    return { id: item.id };
  }),

  /**
   * Import items into an existing roadmap or a new one.
   * - CSV: parsed server-side and applied in the request (bounded) -> { mode: "done", ...result }.
   * - Linear / Jira / Notion / Productboard: a ROADMAP_IMPORT JobRun is queued on
   *   QUEUE.IMPORTS -> { mode: "queued", jobRunId }; poll job.get({ id }).
   * Items upsert on (roadmapId, externalId), so re-imports are idempotent.
   */
  import: outboundProcedure.input(importInput).mutation(async ({ ctx, input }): Promise<ImportResponse> => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    const existing = input.roadmapId ? await roadmapInProject(ctx.prisma, input.roadmapId, project.id) : null;

    if (input.source === "CSV") {
      try {
        const result = await runRoadmapImport({
          projectId: project.id,
          source: "CSV",
          roadmapId: existing?.id ?? null,
          name: input.name ?? null,
          load: async () => ({
            parsed: parseRoadmapCsv(input.csv),
            options: input.filename ? { filename: input.filename.slice(0, 200) } : undefined,
          }),
        });
        return { mode: "done", ...result };
      } catch (err) {
        if (err instanceof ImportError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        throw err;
      }
    }

    const source = input.source;
    const label = SOURCE_LABEL[source];
    const integration = await ctx.prisma.integration.findFirst({
      where: { orgId: project.orgId, provider: source, status: "CONNECTED" },
      select: { id: true },
    });
    if (!integration) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${label} is not connected for this workspace` });
    }
    const params = roadmapImportJobInputSchema.parse({
      source,
      roadmapId: existing?.id ?? null,
      name: input.name ?? null,
      ...(source === "LINEAR" ? { teamId: input.teamId ?? null } : {}),
      ...(source === "JIRA" ? { projectKey: input.projectKey } : {}),
      ...(source === "NOTION" ? { databaseId: input.databaseId } : {}),
    });

    // A second click while the same source is importing returns the running job.
    const inFlight = await ctx.prisma.jobRun.findFirst({
      where: {
        projectId: project.id,
        kind: "ROADMAP_IMPORT",
        status: { in: ["PENDING", "PROCESSING"] },
        input: { path: ["source"], equals: source },
      },
      select: { id: true, status: true },
    });
    if (inFlight) {
      return { mode: "queued", jobRunId: inFlight.id, status: inFlight.status as "PENDING" | "PROCESSING", alreadyRunning: true };
    }

    const run = await ctx.prisma.jobRun.create({
      data: {
        kind: "ROADMAP_IMPORT",
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

  runGapAnalysis: llmProcedure.input(z.object({ projectId: id, roadmapId: id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
    // The roadmap must belong to this project (closes the cross-tenant read/write).
    const roadmap = await roadmapInProject(ctx.prisma, input.roadmapId, project.id);

    const inFlight = await ctx.prisma.gapAnalysis.findFirst({
      where: { projectId: project.id, roadmapId: roadmap.id, status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true, status: true },
    });
    if (inFlight) return { gapAnalysisId: inFlight.id, status: inFlight.status, alreadyRunning: true };

    const [itemCount, latest] = await Promise.all([
      ctx.prisma.roadmapItem.count({ where: { roadmapId: roadmap.id } }),
      getLatestThemes(project.id, { limit: 1, quotesPerTheme: 0 }),
    ]);
    if (itemCount === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Add or import roadmap items before running a gap analysis" });
    }
    if (!latest.synthesisId || latest.themes.length === 0) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Run a synthesis first: gap analysis compares themes against the roadmap" });
    }

    const analysis = await ctx.prisma.gapAnalysis.create({
      data: { projectId: project.id, roadmapId: roadmap.id, synthesisId: latest.synthesisId, status: "PENDING" },
      select: { id: true, status: true },
    });
    await enqueue(QUEUE.GAP_ANALYSIS, { gapAnalysisId: analysis.id }, { jobId: `gap_${analysis.id}` });
    return { gapAnalysisId: analysis.id, status: analysis.status, alreadyRunning: false };
  }),

  /** Latest gap analysis for a roadmap (any status) plus recent history. */
  getGapAnalysis: protectedProcedure
    .input(z.object({ projectId: id, roadmapId: id, historyLimit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const roadmap = await roadmapInProject(ctx.prisma, input.roadmapId, project.id);
      const rows = await ctx.prisma.gapAnalysis.findMany({
        where: { projectId: project.id, roadmapId: roadmap.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.historyLimit,
        select: { id: true, status: true, errorMessage: true, output: true, createdAt: true, completedAt: true, synthesisId: true },
      });
      const [first] = rows;
      const parsedLatest = first ? gapOutputSchema.safeParse(first.output) : null;
      return {
        latest: first
          ? {
              id: first.id,
              status: first.status,
              errorMessage: first.errorMessage,
              createdAt: first.createdAt,
              completedAt: first.completedAt,
              output: parsedLatest?.success ? parsedLatest.data : null,
            }
          : null,
        history: rows.map((r) => ({
          id: r.id,
          status: r.status,
          errorMessage: r.errorMessage,
          createdAt: r.createdAt,
          completedAt: r.completedAt,
          stats: gapStats(r.output),
        })),
      };
    }),

  /** One gap analysis by id (for viewing history). */
  getGapAnalysisById: protectedProcedure
    .input(z.object({ projectId: id, gapAnalysisId: id }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const row = found(
        await ctx.prisma.gapAnalysis.findFirst({
          where: { id: input.gapAnalysisId, projectId: project.id },
          select: { id: true, roadmapId: true, status: true, errorMessage: true, output: true, createdAt: true, completedAt: true },
        }),
        "Gap analysis"
      );
      const parsed = gapOutputSchema.safeParse(row.output);
      return { ...row, output: parsed.success ? parsed.data : null };
    }),
});
