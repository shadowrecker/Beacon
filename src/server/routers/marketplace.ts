/**
 * Marketplace. The catalog is global (seeded built-ins); installs are
 * per active organization (orgProcedure). Installing and uninstalling require
 * integrations:manage. Reviews: one per user per connector, only from members
 * (not viewers) of an org that has the connector installed; one helpful vote
 * per user per review. Aggregates are recomputed server-side.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { can, requireProjectAccess } from "../auth/access";
import { orgProcedure, router } from "../trpc";
import { providerInfo } from "../integrations/index";
import { ensureMarketplaceSeeded } from "../marketplace/registry";
import { connectorProvider, installConnector, uninstallConnector } from "../marketplace/installer";
import { deleteReview, setHelpfulVote, upsertReview } from "../marketplace/reviews";

const id = z.string().min(1).max(64);
const slug = z.string().regex(/^[a-z0-9-]{1,64}$/);
const category = z.enum(["SUPPORT", "CRM", "ANALYTICS", "COMMUNICATION", "PRODUCT", "RESEARCH", "CUSTOM"]);

type OrgCtx = Parameters<typeof requireProjectAccess>[0] & { org: { orgId: string; role: Parameters<typeof can>[0] } };

const listSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  category: true,
  provider: true,
  authType: true,
  pricing: true,
  isOfficial: true,
  isVerified: true,
  installCount: true,
  ratingAverage: true,
  ratingCount: true,
  capabilities: true,
} as const;

function capabilities(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string").slice(0, 20) : [];
}

async function connectorBySlug(ctx: OrgCtx, s: string) {
  await ensureMarketplaceSeeded();
  const c = await ctx.prisma.marketplaceConnector.findUnique({ where: { slug: s } });
  if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Connector not found" });
  return c;
}

function requireManage(ctx: OrgCtx) {
  if (!can(ctx.org.role, "integrations:manage")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can install connectors" });
  }
}

async function installedSet(ctx: OrgCtx, connectorIds: string[]): Promise<Set<string>> {
  if (connectorIds.length === 0) return new Set();
  const rows = await ctx.prisma.connectorInstall.findMany({
    where: { orgId: ctx.org.orgId, connectorId: { in: connectorIds } },
    select: { connectorId: true },
  });
  return new Set(rows.map((r) => r.connectorId));
}

export const marketplaceRouter = router({
  browse: orgProcedure
    .input(
      z.object({
        search: z.string().trim().max(100).optional(),
        category: category.optional(),
        limit: z.number().int().min(1).max(50).default(24),
        cursor: id.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      await ensureMarketplaceSeeded();
      const q = input.search?.trim();
      const rows = await ctx.prisma.marketplaceConnector.findMany({
        where: {
          ...(input.category ? { category: input.category } : {}),
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" as const } },
                  { description: { contains: q, mode: "insensitive" as const } },
                  { provider: { contains: q, mode: "insensitive" as const } },
                ],
              }
            : {}),
        },
        orderBy: [{ isOfficial: "desc" }, { installCount: "desc" }, { name: "asc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: listSelect,
      });
      const items = rows.slice(0, input.limit);
      const installed = await installedSet(ctx, items.map((i) => i.id));
      return {
        items: items.map((c) => ({ ...c, capabilities: capabilities(c.capabilities), installed: installed.has(c.id) })),
        nextCursor: rows.length > input.limit ? items[items.length - 1].id : null,
      };
    }),

  getFeatured: orgProcedure.query(async ({ ctx }) => {
    await ensureMarketplaceSeeded();
    const rows = await ctx.prisma.marketplaceConnector.findMany({
      where: { isOfficial: true },
      orderBy: [{ installCount: "desc" }, { ratingAverage: "desc" }, { name: "asc" }],
      take: 4,
      select: listSelect,
    });
    const installed = await installedSet(ctx, rows.map((r) => r.id));
    return rows.map((c) => ({ ...c, capabilities: capabilities(c.capabilities), installed: installed.has(c.id) }));
  }),

  get: orgProcedure.input(z.object({ slug })).query(async ({ ctx, input }) => {
    const c = await connectorBySlug(ctx, input.slug);
    const provider = connectorProvider(c.provider);
    const [install, myReview] = await Promise.all([
      ctx.prisma.connectorInstall.findUnique({
        where: { connectorId_orgId: { connectorId: c.id, orgId: ctx.org.orgId } },
        select: { id: true, status: true, integrationId: true, createdAt: true },
      }),
      ctx.prisma.connectorReview.findUnique({
        where: { connectorId_userId: { connectorId: c.id, userId: ctx.user.id } },
        select: { id: true, rating: true, title: true, content: true, createdAt: true },
      }),
    ]);
    const integration = provider
      ? await ctx.prisma.integration.findUnique({
          where: { orgId_provider: { orgId: ctx.org.orgId, provider } },
          select: { id: true, status: true, projectId: true, lastSyncAt: true },
        })
      : null;
    const canManage = can(ctx.org.role, "integrations:manage");
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      longDescription: c.longDescription,
      category: c.category,
      provider: c.provider,
      authType: c.authType,
      auth: provider ? providerInfo(provider).auth : null,
      setupGuide: c.setupGuide ?? "",
      capabilities: capabilities(c.capabilities),
      pricing: c.pricing,
      publisherName: c.publisherName,
      publisherUrl: c.publisherUrl && /^https:\/\//.test(c.publisherUrl) ? c.publisherUrl : null,
      isOfficial: c.isOfficial,
      isVerified: c.isVerified,
      version: c.version,
      installCount: c.installCount,
      ratingAverage: c.ratingAverage,
      ratingCount: c.ratingCount,
      install,
      integration,
      myReview,
      canManage,
      canReview: !!install && can(ctx.org.role, "project:write"),
    };
  }),

  listInstalled: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.prisma.connectorInstall.findMany({
      where: { orgId: ctx.org.orgId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        status: true,
        createdAt: true,
        configuredAt: true,
        connector: { select: listSelect },
        integration: { select: { id: true, status: true, lastSyncAt: true, lastError: true } },
      },
    });
    return rows.map((r) => ({ ...r, connector: { ...r.connector, capabilities: capabilities(r.connector.capabilities) } }));
  }),

  install: orgProcedure.input(z.object({ slug, projectId: id })).mutation(async ({ ctx, input }) => {
    requireManage(ctx);
    const c = await connectorBySlug(ctx, input.slug);
    const provider = connectorProvider(c.provider);
    if (!provider) throw new TRPCError({ code: "BAD_REQUEST", message: "This connector can't be installed" });
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    if (project.orgId !== ctx.org.orgId) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
    const res = await installConnector({ connectorId: c.id, provider, orgId: ctx.org.orgId, userId: ctx.user.id });
    return { ...res, projectId: project.id };
  }),

  uninstall: orgProcedure
    .input(z.object({ slug, disconnect: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      requireManage(ctx);
      const c = await connectorBySlug(ctx, input.slug);
      const res = await uninstallConnector({ connectorId: c.id, orgId: ctx.org.orgId, disconnect: input.disconnect });
      if (!res.removed) throw new TRPCError({ code: "NOT_FOUND", message: "This connector isn't installed" });
      return res;
    }),

  getReviews: orgProcedure
    .input(
      z.object({
        slug,
        sort: z.enum(["recent", "helpful"]).default("recent"),
        limit: z.number().int().min(1).max(50).default(10),
        cursor: id.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const c = await connectorBySlug(ctx, input.slug);
      const rows = await ctx.prisma.connectorReview.findMany({
        where: { connectorId: c.id },
        orderBy: input.sort === "helpful" ? [{ helpful: "desc" }, { createdAt: "desc" }, { id: "desc" }] : [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, userId: true, rating: true, title: true, content: true, helpful: true, createdAt: true },
      });
      const items = rows.slice(0, input.limit);
      const [authors, votes] = await Promise.all([
        ctx.prisma.user.findMany({ where: { id: { in: [...new Set(items.map((r) => r.userId))] } }, select: { id: true, name: true } }),
        ctx.prisma.connectorReviewVote.findMany({ where: { userId: ctx.user.id, reviewId: { in: items.map((r) => r.id) } }, select: { reviewId: true } }),
      ]);
      const names = new Map(authors.map((a) => [a.id, a.name]));
      const voted = new Set(votes.map((v) => v.reviewId));
      return {
        items: items.map(({ userId, ...r }) => ({
          ...r,
          authorName: names.get(userId) || "Beacon user",
          isMine: userId === ctx.user.id,
          votedHelpful: voted.has(r.id),
        })),
        nextCursor: rows.length > input.limit ? items[items.length - 1].id : null,
      };
    }),

  addReview: orgProcedure
    .input(
      z.object({
        slug,
        rating: z.number().int().min(1).max(5),
        title: z.string().trim().max(120).optional(),
        content: z.string().trim().max(5000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.org.role, "project:write")) throw new TRPCError({ code: "FORBIDDEN", message: "Viewers can't write reviews" });
      const c = await connectorBySlug(ctx, input.slug);
      const installed = await ctx.prisma.connectorInstall.findUnique({
        where: { connectorId_orgId: { connectorId: c.id, orgId: ctx.org.orgId } },
        select: { id: true },
      });
      if (!installed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Install this connector before reviewing it" });
      return upsertReview({
        connectorId: c.id,
        userId: ctx.user.id,
        orgId: ctx.org.orgId,
        rating: input.rating,
        title: input.title || null,
        content: input.content || null,
      });
    }),

  deleteReview: orgProcedure.input(z.object({ slug })).mutation(async ({ ctx, input }) => {
    const c = await connectorBySlug(ctx, input.slug);
    const removed = await deleteReview(c.id, ctx.user.id);
    if (!removed) throw new TRPCError({ code: "NOT_FOUND", message: "Review not found" });
    return { removed };
  }),

  markReviewHelpful: orgProcedure
    .input(z.object({ reviewId: id, helpful: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.org.role, "project:write")) throw new TRPCError({ code: "FORBIDDEN", message: "Viewers can't vote on reviews" });
      const review = await ctx.prisma.connectorReview.findUnique({ where: { id: input.reviewId }, select: { id: true, userId: true } });
      if (!review) throw new TRPCError({ code: "NOT_FOUND", message: "Review not found" });
      if (review.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "You can't vote on your own review" });
      return setHelpfulVote(review.id, ctx.user.id, input.helpful);
    }),
});
