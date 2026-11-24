/**
 * API key management. Keys belong to an org; creating and revoking
 * requires apiKeys:manage (OWNER/ADMIN). Members can see key metadata (never
 * the key or its hash). The full key is returned exactly once, from create.
 */
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { router, orgProcedure } from "../trpc";
import { can, found, requireOrgPermission } from "../auth/access";
import { assertCanCreate } from "../usage/entitlements";
import { generateApiKey, scopesSchema } from "../api/auth";
import { DEFAULT_RATE_LIMIT, MAX_KEY_LIFETIME_DAYS, MAX_RATE_LIMIT } from "../api/scopes";

const id = z.string().min(1).max(64);
const orgId = id.optional();

export const apiKeyRouter = router({
  list: orgProcedure
    .input(
      z
        .object({
          orgId,
          includeRevoked: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(50),
          cursor: id.optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const rows = await ctx.prisma.apiKey.findMany({
        where: { orgId: ctx.org.orgId, ...(input?.includeRevoked ? {} : { revokedAt: null }) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          rateLimit: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
          createdBy: true,
        },
      });
      const page = rows.slice(0, limit);
      const creators = await ctx.prisma.user.findMany({
        where: { id: { in: [...new Set(page.map((k) => k.createdBy))] } },
        select: { id: true, name: true, email: true },
      });
      const byId = new Map(creators.map((u) => [u.id, u]));
      return {
        items: page.map((k) => ({
          ...k,
          createdBy: byId.get(k.createdBy)?.name ?? byId.get(k.createdBy)?.email ?? "Former member",
        })),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        canManage: can(ctx.org.role, "apiKeys:manage"),
      };
    }),

  /** Create a key. The plaintext key is in the response and never again. */
  create: orgProcedure
    .input(
      z.object({
        orgId,
        name: z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters"),
        scopes: scopesSchema,
        rateLimit: z.number().int().min(1).max(MAX_RATE_LIMIT, `At most ${MAX_RATE_LIMIT} requests per minute`).default(DEFAULT_RATE_LIMIT),
        expiresInDays: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireOrgPermission(ctx, ctx.org.orgId, "apiKeys:manage");
      await assertCanCreate(ctx.org.orgId, "apiKeys");
      const { key, keyHash, prefix } = generateApiKey();
      const row = await ctx.prisma.apiKey.create({
        data: {
          orgId: ctx.org.orgId,
          name: input.name,
          keyHash,
          prefix,
          scopes: input.scopes,
          rateLimit: input.rateLimit,
          createdBy: ctx.user.id,
          expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
        },
        select: { id: true, name: true, prefix: true, scopes: true, rateLimit: true, expiresAt: true, createdAt: true },
      });
      return { ...row, key };
    }),

  revoke: orgProcedure.input(z.object({ orgId, id })).mutation(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, ctx.org.orgId, "apiKeys:manage");
    const key = found(
      await ctx.prisma.apiKey.findFirst({ where: { id: input.id, orgId: ctx.org.orgId }, select: { id: true, revokedAt: true } }),
      "API key"
    );
    if (!key.revokedAt) {
      await ctx.prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    }
    return { id: key.id, revoked: true };
  }),

  /** Aggregated request statistics for the org's keys (or one key). */
  getUsage: orgProcedure
    .input(z.object({ orgId, keyId: id.optional(), days: z.number().int().min(1).max(90).default(30) }).optional())
    .query(async ({ ctx, input }) => {
      const days = input?.days ?? 30;
      const since = new Date(Date.now() - days * 86_400_000);
      if (input?.keyId) {
        found(await ctx.prisma.apiKey.findFirst({ where: { id: input.keyId, orgId: ctx.org.orgId }, select: { id: true } }), "API key");
      }
      const keyFilter = input?.keyId ? Prisma.sql`AND u."apiKeyId" = ${input.keyId}` : Prisma.empty;
      const base = Prisma.sql`
        FROM "api_usage" u JOIN "api_keys" k ON k.id = u."apiKeyId"
        WHERE k."orgId" = ${ctx.org.orgId} AND u."timestamp" >= ${since} ${keyFilter}`;

      const [totals] = await ctx.prisma.$queryRaw<Array<{ requests: number; errors: number; avgLatency: number | null; p95Latency: number | null }>>`
        SELECT count(*)::int AS requests,
               (count(*) FILTER (WHERE u."statusCode" >= 400))::int AS errors,
               avg(u."latencyMs")::float AS "avgLatency",
               percentile_cont(0.95) WITHIN GROUP (ORDER BY u."latencyMs")::float AS "p95Latency"
        ${base}`;
      const byDay = await ctx.prisma.$queryRaw<Array<{ day: Date; requests: number; errors: number }>>`
        SELECT date_trunc('day', u."timestamp") AS day,
               count(*)::int AS requests,
               (count(*) FILTER (WHERE u."statusCode" >= 400))::int AS errors
        ${base}
        GROUP BY 1 ORDER BY 1`;
      const byEndpoint = await ctx.prisma.$queryRaw<Array<{ method: string; endpoint: string; requests: number; errors: number; avgLatency: number | null }>>`
        SELECT u.method, u.endpoint,
               count(*)::int AS requests,
               (count(*) FILTER (WHERE u."statusCode" >= 400))::int AS errors,
               avg(u."latencyMs")::float AS "avgLatency"
        ${base}
        GROUP BY u.method, u.endpoint ORDER BY requests DESC LIMIT 25`;
      const byStatus = await ctx.prisma.$queryRaw<Array<{ statusClass: string; requests: number }>>`
        SELECT ((u."statusCode" / 100)::int)::text || 'xx' AS "statusClass", count(*)::int AS requests
        ${base}
        GROUP BY 1 ORDER BY 1`;
      return {
        days,
        totals: {
          requests: totals?.requests ?? 0,
          errors: totals?.errors ?? 0,
          avgLatencyMs: totals?.avgLatency !== null && totals?.avgLatency !== undefined ? Math.round(totals.avgLatency) : null,
          p95LatencyMs: totals?.p95Latency !== null && totals?.p95Latency !== undefined ? Math.round(totals.p95Latency) : null,
        },
        byDay: byDay.map((d) => ({ day: d.day.toISOString().slice(0, 10), requests: d.requests, errors: d.errors })),
        byEndpoint: byEndpoint.map((e) => ({ ...e, avgLatencyMs: e.avgLatency === null ? null : Math.round(e.avgLatency) })),
        byStatus,
      };
    }),
});
