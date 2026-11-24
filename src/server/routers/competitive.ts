/**
 * Competitive intelligence. Competitors belong to the active
 * organization. Members can add and edit competitors and record manual updates
 * (review insights are entered manually, never scraped); scans need
 * ai:run and are rate limited like other LLM work. URLs are restricted to
 * http(s) so nothing like `javascript:` can be stored and rendered as a link.
 */
import { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { sha256Hex } from "@/lib/crypto";
import type { DbClient } from "@/lib/db";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { can, type Permission } from "../auth/access";
import { emitEvent } from "../events/bus";
import { enqueue, QUEUE } from "../jobs/queues";
import { orgProcedure, rateLimited, router } from "../trpc";

const id = z.string().min(1).max(64);

/** http(s) URL only (scheme allowlist), no embedded credentials. */
export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !!u.hostname;
    } catch {
      return false;
    }
  }, "Enter a valid http(s) URL");

const optionalUrl = z.union([httpUrl, z.literal("")]).optional().transform((v) => (v ? v : null));

const competitorFields = {
  name: z.string().trim().min(1, "Name is required").max(120),
  website: optionalUrl,
  description: z.string().trim().max(2000).optional().transform((v) => v || null),
  g2Url: optionalUrl,
  captureUrl: optionalUrl,
};

const updateType = z.enum(["CHANGELOG", "REVIEW", "PRESS", "PRICING", "FEATURE"]);
const sentiment = z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"]);

type OrgCtx = { prisma: DbClient; user: { id: string }; org: { orgId: string; role: Parameters<typeof can>[0] } };

function requirePerm(ctx: OrgCtx, permission: Permission, message = "You do not have permission to do this") {
  if (!can(ctx.org.role, permission)) throw new TRPCError({ code: "FORBIDDEN", message });
}

async function requireCompetitor(ctx: OrgCtx, competitorId: string) {
  const c = await ctx.prisma.competitorProfile.findFirst({ where: { id: competitorId, orgId: ctx.org.orgId }, select: { id: true, name: true } });
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Competitor not found" });
  return c;
}

const competitorSelect = {
  id: true,
  name: true,
  website: true,
  description: true,
  g2Url: true,
  captureUrl: true,
  lastScannedAt: true,
  lastScanError: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function activeScan(ctx: OrgCtx, competitorId: string) {
  return ctx.prisma.jobRun.findFirst({
    where: {
      orgId: ctx.org.orgId,
      kind: "COMPETITIVE_SCAN",
      status: { in: ["PENDING", "PROCESSING"] },
      input: { path: ["competitorId"], equals: competitorId },
      createdAt: { gt: new Date(Date.now() - 60 * 60_000) },
    },
    select: { id: true, status: true },
    orderBy: { createdAt: "desc" },
  });
}

export const competitiveRouter = router({
  listCompetitors: orgProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50), cursor: id.optional() }).default({ limit: 50 }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.prisma.competitorProfile.findMany({
        where: { orgId: ctx.org.orgId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          ...competitorSelect,
          _count: { select: { updates: true, alerts: { where: { userId: ctx.user.id, isRead: false } } } },
          updates: { orderBy: { detectedAt: "desc" }, take: 1, select: { id: true, title: true, type: true, detectedAt: true } },
        },
      });
      const items = rows.slice(0, input.limit).map(({ _count, updates, ...c }) => ({
        ...c,
        updateCount: _count.updates,
        unreadAlerts: _count.alerts,
        latestUpdate: updates[0] ?? null,
      }));
      return { items, nextCursor: rows.length > input.limit ? items[items.length - 1].id : null, canEdit: can(ctx.org.role, "project:write"), canScan: can(ctx.org.role, "ai:run") };
    }),

  getCompetitor: orgProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const c = await ctx.prisma.competitorProfile.findFirst({
      where: { id: input.id, orgId: ctx.org.orgId },
      select: { ...competitorSelect, _count: { select: { updates: true } } },
    });
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Competitor not found" });
    const scan = await activeScan(ctx, c.id);
    const { _count, ...rest } = c;
    return { ...rest, updateCount: _count.updates, activeScanId: scan?.id ?? null, canEdit: can(ctx.org.role, "project:write"), canScan: can(ctx.org.role, "ai:run") };
  }),

  addCompetitor: orgProcedure.input(z.object(competitorFields)).mutation(async ({ ctx, input }) => {
    requirePerm(ctx, "project:write", "Viewers can't add competitors");
    const count = await ctx.prisma.competitorProfile.count({ where: { orgId: ctx.org.orgId } });
    if (count >= 200) throw new TRPCError({ code: "FORBIDDEN", message: "A workspace can track up to 200 competitors" });
    return ctx.prisma.competitorProfile.create({
      data: { ...input, orgId: ctx.org.orgId, userId: ctx.user.id },
      select: competitorSelect,
    });
  }),

  updateCompetitor: orgProcedure
    .input(
      z.object({
        id,
        name: competitorFields.name.optional(),
        website: optionalUrl,
        description: z.string().trim().max(2000).optional(),
        g2Url: optionalUrl,
        captureUrl: optionalUrl,
      })
    )
    .mutation(async ({ ctx, input }) => {
      requirePerm(ctx, "project:write", "Viewers can't edit competitors");
      const c = await requireCompetitor(ctx, input.id);
      const { id: _id, ...fields } = input;
      const data: Prisma.CompetitorProfileUpdateInput = {};
      if (fields.name !== undefined) data.name = fields.name;
      if (fields.description !== undefined) data.description = fields.description || null;
      // `undefined` = unchanged; empty string clears (transformed to null).
      if (input.website !== undefined) data.website = fields.website;
      if (input.g2Url !== undefined) data.g2Url = fields.g2Url;
      if (input.captureUrl !== undefined) data.captureUrl = fields.captureUrl;
      return ctx.prisma.competitorProfile.update({ where: { id: c.id }, data, select: competitorSelect });
    }),

  removeCompetitor: orgProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    requirePerm(ctx, "project:write", "Viewers can't remove competitors");
    const c = await requireCompetitor(ctx, input.id);
    await ctx.prisma.competitorProfile.delete({ where: { id: c.id } });
    return { id: c.id };
  }),

  getUpdates: orgProcedure
    .input(z.object({ competitorId: id, type: updateType.optional(), limit: z.number().int().min(1).max(100).default(20), cursor: id.optional() }))
    .query(async ({ ctx, input }) => {
      const c = await requireCompetitor(ctx, input.competitorId);
      const rows = await ctx.prisma.competitorUpdate.findMany({
        where: { competitorId: c.id, ...(input.type ? { type: input.type } : {}) },
        orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, type: true, title: true, content: true, sourceUrl: true, isManual: true, sentiment: true, detectedAt: true },
      });
      const items = rows.slice(0, input.limit).map((u) => ({ ...u, content: u.content.slice(0, 4_000) }));
      return { items, nextCursor: rows.length > input.limit ? items[items.length - 1].id : null };
    }),

  getAlerts: orgProcedure
    .input(z.object({ unreadOnly: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20), cursor: id.optional() }).default({ unreadOnly: false, limit: 20 }))
    .query(async ({ ctx, input }) => {
      const where = { userId: ctx.user.id, competitor: { orgId: ctx.org.orgId }, ...(input.unreadOnly ? { isRead: false } : {}) };
      const [rows, unread] = await Promise.all([
        ctx.prisma.competitorAlert.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: { id: true, type: true, message: true, isRead: true, createdAt: true, competitor: { select: { id: true, name: true } } },
        }),
        ctx.prisma.competitorAlert.count({ where: { userId: ctx.user.id, competitor: { orgId: ctx.org.orgId }, isRead: false } }),
      ]);
      const items = rows.slice(0, input.limit);
      return { items, unread, nextCursor: rows.length > input.limit ? items[items.length - 1].id : null };
    }),

  markAlertRead: orgProcedure
    .input(z.union([z.object({ id }), z.object({ all: z.literal(true), competitorId: id.optional() })]))
    .mutation(async ({ ctx, input }) => {
      const base = { userId: ctx.user.id, competitor: { orgId: ctx.org.orgId } };
      if ("id" in input) {
        const res = await ctx.prisma.competitorAlert.updateMany({ where: { ...base, id: input.id }, data: { isRead: true } });
        if (res.count === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Alert not found" });
        return { updated: res.count };
      }
      const res = await ctx.prisma.competitorAlert.updateMany({
        where: { ...base, isRead: false, ...(input.competitorId ? { competitorId: input.competitorId } : {}) },
        data: { isRead: true },
      });
      return { updated: res.count };
    }),

  runScan: orgProcedure
    .use(rateLimited(RATE_LIMITS.llm))
    .use(rateLimited(RATE_LIMITS.llmHourly))
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      requirePerm(ctx, "ai:run", "Viewers can't run scans");
      const c = await ctx.prisma.competitorProfile.findFirst({
        where: { id: input.id, orgId: ctx.org.orgId },
        select: { id: true, website: true, captureUrl: true },
      });
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Competitor not found" });
      if (!c.website && !c.captureUrl) throw new TRPCError({ code: "BAD_REQUEST", message: "Add a website or a page to monitor first" });
      const existing = await activeScan(ctx, c.id);
      if (existing) return { jobRunId: existing.id, alreadyRunning: true };
      const run = await ctx.prisma.jobRun.create({
        data: { kind: "COMPETITIVE_SCAN", orgId: ctx.org.orgId, createdById: ctx.user.id, status: "PENDING", input: { competitorId: c.id } },
        select: { id: true },
      });
      await enqueue(QUEUE.COMPETITIVE_SCAN, { competitorId: c.id, jobRunId: run.id }, { jobId: `compscan_${c.id}_${run.id}` });
      return { jobRunId: run.id, alreadyRunning: false };
    }),

  addManualUpdate: orgProcedure
    .input(
      z.object({
        competitorId: id,
        type: updateType,
        title: z.string().trim().min(1, "Title is required").max(200),
        content: z.string().trim().min(1, "Add the details").max(10_000),
        sourceUrl: optionalUrl,
        sentiment: sentiment.default("NEUTRAL"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requirePerm(ctx, "project:write", "Viewers can't add updates");
      const c = await requireCompetitor(ctx, input.competitorId);
      const contentHash = sha256Hex(`manual|${input.type}|${input.title.toLowerCase()}|${input.content}`);
      const duplicate = await ctx.prisma.competitorUpdate.findUnique({
        where: { competitorId_contentHash: { competitorId: c.id, contentHash } },
        select: { id: true },
      });
      if (duplicate) throw new TRPCError({ code: "CONFLICT", message: "This update has already been recorded" });
      let row;
      try {
        row = await ctx.prisma.competitorUpdate.create({
          data: {
            competitorId: c.id,
            type: input.type,
            title: input.title,
            content: input.content,
            sourceUrl: input.sourceUrl,
            sentiment: input.sentiment,
            contentHash,
            isManual: true,
          },
          select: { id: true, type: true, title: true, content: true, sourceUrl: true, isManual: true, sentiment: true, detectedAt: true },
        });
      } catch (err) {
        if ((err as Prisma.PrismaClientKnownRequestError).code === "P2002") {
          throw new TRPCError({ code: "CONFLICT", message: "This update has already been recorded" });
        }
        throw err;
      }
      await emitEvent({
        orgId: ctx.org.orgId,
        type: "competitor.updated",
        payload: { competitorId: c.id, updateId: row.id, type: row.type, title: row.title },
        actorUserId: ctx.user.id,
      });
      return row;
    }),

  deleteUpdate: orgProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    requirePerm(ctx, "project:write", "Viewers can't delete updates");
    const update = await ctx.prisma.competitorUpdate.findFirst({
      where: { id: input.id, competitor: { orgId: ctx.org.orgId } },
      select: { id: true, isManual: true, contentHash: true, competitor: { select: { id: true, metadata: true } } },
    });
    if (!update) throw new TRPCError({ code: "NOT_FOUND", message: "Update not found" });
    await ctx.prisma.competitorUpdate.delete({ where: { id: update.id } });
    if (!update.isManual && update.contentHash) {
      // Remember the section as seen so the next scan doesn't re-create a dismissed update.
      const meta = (update.competitor.metadata && typeof update.competitor.metadata === "object" ? update.competitor.metadata : {}) as Record<string, unknown>;
      const scan = (meta.scan && typeof meta.scan === "object" ? meta.scan : {}) as { seenHashes?: unknown };
      const seen = Array.isArray(scan.seenHashes) ? scan.seenHashes.filter((h): h is string => typeof h === "string") : [];
      await ctx.prisma.competitorProfile.update({
        where: { id: update.competitor.id },
        data: { metadata: { ...meta, scan: { ...scan, seenHashes: [update.contentHash, ...seen].slice(0, 500) } } as Prisma.InputJsonValue },
      });
    }
    return { id: update.id };
  }),
});
