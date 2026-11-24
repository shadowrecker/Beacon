/**
 * Knowledge graph API. Every procedure is org-scoped through orgProcedure
 * (membership verified), and every entity, relation and suggestion lookup
 * includes the active org ID, so IDs from another org resolve to NOT_FOUND.
 */
import { EntityType, MergeSuggestionStatus, RelationType, type Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { prisma, type DbClient } from "@/lib/db";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { can, found, requireProjectAccess, roleRank } from "../auth/access";
import { orgProcedure, rateLimited, router } from "../trpc";
import { assertTokenBudget, BudgetExceededError } from "../usage/entitlements";
import { LLMError } from "../ai/client";
import { getNeighborhood, graphStats, MAX_NEIGHBORHOOD_DEPTH, MAX_PATH_DEPTH, shortestPath, topHubs } from "../ai/knowledge/graph";
import { answerKnowledgeQuestion, parseStoredResult } from "../ai/knowledge/query";
import { lockOrgGraph, mergeEntitiesInTx, MergeNotFoundError, parseEntityMeta, parseQuotes } from "../ai/knowledge/store";
import { excerptAround } from "../ai/knowledge/text";

/** llmProcedure's rate limits, on top of active-org resolution. */
const orgLlmProcedure = orgProcedure.use(rateLimited(RATE_LIMITS.llm)).use(rateLimited(RATE_LIMITS.llmHourly));

const id = z.string().min(1).max(64);
const orgField = { orgId: id.optional() };
const limit = (max: number, dflt: number) => z.number().int().min(1).max(max).default(dflt);

const entitySummarySelect = { id: true, name: true, type: true, mentionCount: true } as const;

function permissionsFor(role: Parameters<typeof can>[0]) {
  return { canWrite: can(role, "project:write"), canDelete: roleRank(role) >= roleRank("ADMIN") };
}

/** Resolve evidence (document/chunk IDs) to links, keeping only documents in the org. */
async function documentLinks(db: DbClient, orgId: string, documentIds: string[]) {
  if (documentIds.length === 0) return new Map<string, { id: string; title: string; projectId: string }>();
  const docs = await db.document.findMany({
    where: { id: { in: [...new Set(documentIds)] }, project: { orgId } },
    select: { id: true, title: true, projectId: true },
  });
  return new Map(docs.map((d) => [d.id, d]));
}

export const knowledgeRouter = router({
  listEntities: orgProcedure
    .input(
      z.object({
        ...orgField,
        type: z.enum(EntityType).optional(),
        search: z.string().trim().max(200).optional(),
        projectId: id.optional(),
        sort: z.enum(["mentions", "recent", "name"]).default("mentions"),
        limit: limit(100, 25),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const orgId = ctx.org.orgId;
      if (input.projectId) {
        const project = await requireProjectAccess(ctx, input.projectId, "project:read");
        if (project.orgId !== orgId) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }
      const where: Prisma.KnowledgeEntityWhereInput = {
        orgId,
        ...(input.type ? { type: input.type } : {}),
        ...(input.projectId ? { projectNodes: { some: { projectId: input.projectId } } } : {}),
        ...(input.search
          ? {
              OR: [
                { name: { contains: input.search, mode: "insensitive" } },
                { aliases: { has: input.search } },
                { description: { contains: input.search, mode: "insensitive" } },
              ],
            }
          : {}),
      };
      const orderBy: Prisma.KnowledgeEntityOrderByWithRelationInput[] =
        input.sort === "recent"
          ? [{ lastSeenAt: "desc" }, { id: "asc" }]
          : input.sort === "name"
            ? [{ name: "asc" }, { id: "asc" }]
            : [{ mentionCount: "desc" }, { id: "asc" }];
      const rows = await ctx.prisma.knowledgeEntity.findMany({
        where,
        orderBy,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          type: true,
          description: true,
          confidence: true,
          mentionCount: true,
          lastSeenAt: true,
          _count: { select: { relationsFrom: true, relationsTo: true } },
        },
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description ? r.description.slice(0, 300) : null,
        confidence: r.confidence,
        mentionCount: r.mentionCount,
        lastSeenAt: r.lastSeenAt,
        relationCount: r._count.relationsFrom + r._count.relationsTo,
      }));
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }),

  getEntity: orgProcedure.input(z.object({ ...orgField, entityId: id })).query(async ({ ctx, input }) => {
    const orgId = ctx.org.orgId;
    const entity = found(
      await ctx.prisma.knowledgeEntity.findFirst({
        where: { id: input.entityId, orgId },
        select: {
          id: true,
          name: true,
          type: true,
          description: true,
          aliases: true,
          confidence: true,
          mentionCount: true,
          firstSeenAt: true,
          lastSeenAt: true,
          metadata: true,
          projectNodes: {
            where: { project: { orgId } },
            take: 50,
            orderBy: { createdAt: "desc" },
            select: { project: { select: { id: true, name: true } } },
          },
          _count: { select: { relationsFrom: true, relationsTo: true } },
        },
      }),
      "Entity"
    );

    const meta = parseEntityMeta(entity.metadata);
    const mentionRefs = meta.mentions.slice(0, 10);
    const chunks = mentionRefs.length
      ? await ctx.prisma.chunk.findMany({
          where: { id: { in: mentionRefs.map((m) => m.chunkId) }, project: { orgId } },
          select: { id: true, content: true, documentId: true, projectId: true, document: { select: { title: true } } },
        })
      : [];
    const chunkById = new Map(chunks.map((c) => [c.id, c]));
    const mentions = mentionRefs.flatMap((m) => {
      const c = chunkById.get(m.chunkId);
      if (!c) return [];
      const excerpt = excerptAround(c.content, entity.name) ?? `${c.content.replace(/\s+/g, " ").slice(0, 280)}…`;
      return [{ chunkId: c.id, documentId: c.documentId, documentTitle: c.document.title, projectId: c.projectId, excerpt }];
    });

    return {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      description: entity.description,
      aliases: entity.aliases,
      confidence: entity.confidence,
      mentionCount: entity.mentionCount,
      firstSeenAt: entity.firstSeenAt,
      lastSeenAt: entity.lastSeenAt,
      relationCount: entity._count.relationsFrom + entity._count.relationsTo,
      projects: entity.projectNodes.map((n) => n.project),
      mentions,
      permissions: permissionsFor(ctx.org.role),
    };
  }),

  getEntityNeighborhood: orgProcedure
    .input(z.object({ ...orgField, entityId: id, depth: z.number().int().min(1).max(MAX_NEIGHBORHOOD_DEPTH).default(1) }))
    .query(async ({ ctx, input }) => {
      return found(await getNeighborhood(ctx.org.orgId, input.entityId, input.depth, ctx.prisma), "Entity");
    }),

  getRelations: orgProcedure
    .input(
      z.object({
        ...orgField,
        entityId: id,
        /** Which side the entity is on ("direction" is reserved by tRPC infinite queries). */
        side: z.enum(["in", "out", "both"]).default("both"),
        type: z.enum(RelationType).optional(),
        limit: limit(50, 20),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const orgId = ctx.org.orgId;
      found(await ctx.prisma.knowledgeEntity.findFirst({ where: { id: input.entityId, orgId }, select: { id: true } }), "Entity");
      const ends =
        input.side === "in"
          ? [{ targetId: input.entityId }]
          : input.side === "out"
            ? [{ sourceId: input.entityId }]
            : [{ sourceId: input.entityId }, { targetId: input.entityId }];
      const rows = await ctx.prisma.knowledgeRelation.findMany({
        where: { OR: ends, source: { orgId }, target: { orgId }, ...(input.type ? { type: input.type } : {}) },
        orderBy: [{ strength: "desc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          type: true,
          strength: true,
          evidenceDocuments: true,
          evidenceQuotes: true,
          firstSeenAt: true,
          lastSeenAt: true,
          source: { select: entitySummarySelect },
          target: { select: entitySummarySelect },
        },
      });
      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      const quotesById = new Map(page.map((r) => [r.id, parseQuotes(r.evidenceQuotes).slice(0, 3)]));
      const docs = await documentLinks(ctx.prisma, orgId, [...quotesById.values()].flat().map((q) => q.documentId));
      const items = page.map((r) => ({
        id: r.id,
        type: r.type,
        strength: r.strength,
        direction: r.source.id === input.entityId ? ("out" as const) : ("in" as const),
        source: r.source,
        target: r.target,
        documentCount: r.evidenceDocuments.length,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        evidence: (quotesById.get(r.id) ?? []).flatMap((q) => {
          const d = docs.get(q.documentId);
          return d ? [{ quote: q.quote, chunkId: q.chunkId, documentId: d.id, documentTitle: d.title, projectId: d.projectId }] : [];
        }),
      }));
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    }),

  findShortestPath: orgProcedure
    .input(z.object({ ...orgField, sourceId: id, targetId: id, maxDepth: z.number().int().min(1).max(MAX_PATH_DEPTH).default(MAX_PATH_DEPTH) }))
    .query(async ({ ctx, input }) => {
      const steps = found(await shortestPath(ctx.org.orgId, input.sourceId, input.targetId, input.maxDepth, ctx.prisma), "Entity");
      return { found: steps.length > 0, steps };
    }),

  getStats: orgProcedure.input(z.object({ ...orgField }).optional()).query(async ({ ctx }) => {
    const stats = await graphStats(ctx.org.orgId, ctx.prisma);
    return { ...stats, permissions: permissionsFor(ctx.org.role) };
  }),

  getTopHubs: orgProcedure.input(z.object({ ...orgField, limit: limit(50, 20) })).query(async ({ ctx, input }) => {
    return topHubs(ctx.org.orgId, input.limit, ctx.prisma);
  }),

  getRecentQueries: orgProcedure.input(z.object({ ...orgField, limit: limit(50, 10), cursor: id.nullish() })).query(async ({ ctx, input }) => {
    const rows = await ctx.prisma.knowledgeQuery.findMany({
      where: { orgId: ctx.org.orgId, userId: ctx.user.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: { id: true, query: true, results: true, createdAt: true },
    });
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((q) => {
      const r = parseStoredResult(q.results);
      return {
        id: q.id,
        query: q.query.slice(0, 1000),
        createdAt: q.createdAt,
        answerPreview: r ? r.answer.slice(0, 400) : null,
        confidence: r?.confidence ?? null,
        citedCount: r?.citedEntityIds.length ?? 0,
      };
    });
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }),

  query: orgLlmProcedure.input(z.object({ ...orgField, question: z.string().trim().min(3).max(1000) })).mutation(async ({ ctx, input }) => {
    if (!can(ctx.org.role, "ai:run")) throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to do this" });
    try {
      await assertTokenBudget(ctx.org.orgId);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: err.message });
      throw err;
    }
    try {
      return await answerKnowledgeQuestion({ orgId: ctx.org.orgId, userId: ctx.user.id, question: input.question });
    } catch (err) {
      if (err instanceof LLMError && err.reason !== "not_configured") {
        throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: "The question could not be answered. Try rephrasing it." });
      }
      throw err;
    }
  }),

  listMergeSuggestions: orgProcedure
    .input(z.object({ ...orgField, status: z.enum(MergeSuggestionStatus).default("PENDING"), limit: limit(50, 20), cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const select = { id: true, name: true, type: true, mentionCount: true, description: true, aliases: true } as const;
      const rows = await ctx.prisma.knowledgeMergeSuggestion.findMany({
        where: { orgId: ctx.org.orgId, status: input.status, source: { orgId: ctx.org.orgId }, target: { orgId: ctx.org.orgId } },
        orderBy: [{ similarity: "desc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, similarity: true, status: true, createdAt: true, decidedAt: true, source: { select }, target: { select } },
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((s) => ({
        ...s,
        source: { ...s.source, aliases: s.source.aliases.slice(0, 10), description: s.source.description?.slice(0, 300) ?? null },
        target: { ...s.target, aliases: s.target.aliases.slice(0, 10), description: s.target.description?.slice(0, 300) ?? null },
      }));
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null, permissions: permissionsFor(ctx.org.role) };
    }),

  acceptMergeSuggestion: orgProcedure
    .input(z.object({ ...orgField, suggestionId: id, keep: z.enum(["target", "source"]).default("target") }))
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.org.orgId;
      if (!can(ctx.org.role, "project:write")) throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to do this" });
      try {
        return await prisma.$transaction(
          async (tx) => {
            await lockOrgGraph(tx, orgId);
            const s = found(
              await tx.knowledgeMergeSuggestion.findFirst({
                where: { id: input.suggestionId, orgId, status: "PENDING" },
                select: { sourceId: true, targetId: true },
              }),
              "Merge suggestion"
            );
            const [from, into] = input.keep === "target" ? [s.sourceId, s.targetId] : [s.targetId, s.sourceId];
            // Both entities are re-verified in the org inside mergeEntitiesInTx.
            await mergeEntitiesInTx(tx, orgId, from, into);
            return { mergedIntoId: into, removedId: from };
          },
          { timeout: 60_000, maxWait: 15_000 }
        );
      } catch (err) {
        if (err instanceof MergeNotFoundError) throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
        throw err;
      }
    }),

  rejectMergeSuggestion: orgProcedure.input(z.object({ ...orgField, suggestionId: id })).mutation(async ({ ctx, input }) => {
    if (!can(ctx.org.role, "project:write")) throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to do this" });
    const res = await ctx.prisma.knowledgeMergeSuggestion.updateMany({
      where: { id: input.suggestionId, orgId: ctx.org.orgId, status: "PENDING" },
      data: { status: "REJECTED", decidedById: ctx.user.id, decidedAt: new Date() },
    });
    if (res.count === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Merge suggestion not found" });
    return { id: input.suggestionId, status: "REJECTED" as const };
  }),

  deleteEntity: orgProcedure.input(z.object({ ...orgField, entityId: id })).mutation(async ({ ctx, input }) => {
    const orgId = ctx.org.orgId;
    const exists = await ctx.prisma.knowledgeEntity.findFirst({ where: { id: input.entityId, orgId }, select: { id: true } });
    if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found" });
    if (roleRank(ctx.org.role) < roleRank("ADMIN")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace admins can delete entities" });
    }
    await prisma.$transaction(async (tx) => {
      await lockOrgGraph(tx, orgId);
      // Relations, project links and merge suggestions cascade.
      await tx.knowledgeEntity.deleteMany({ where: { id: input.entityId, orgId } });
    });
    return { id: input.entityId, deleted: true };
  }),
});
