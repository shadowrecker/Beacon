/**
 * Knowledge graph writes. Every mutation of an org's graph runs inside a
 * transaction holding a per-org advisory lock, so concurrent extractions and
 * merges never race on read-modify-write of counts and evidence arrays.
 *
 * Per-document contributions (mentions per entity, relation IDs, evidence chunk
 * IDs) are recorded on the document's knowledge JobRun so re-processing a
 * document first reverts what it contributed before, which keeps counts exact
 * and re-runs idempotent.
 */
import { Prisma, type EntityType, type RelationType } from "@prisma/client";
import { z } from "zod";
import type { DbClient } from "@/lib/db";
import { uniqueCapped } from "./text";

export const MAX_ALIASES_STORED = 50;
export const MAX_ENTITY_MENTIONS_STORED = 30;
export const MAX_MERGED_FROM = 200;
export const MAX_RELATION_DOCUMENTS = 1_000;
export const MAX_RELATION_CHUNK_IDS = 200;
export const MAX_RELATION_QUOTES = 25;

/** Relation types whose direction carries no meaning: stored with sorted endpoints. */
const SYMMETRIC: ReadonlySet<RelationType> = new Set<RelationType>(["RELATES_TO", "SIMILAR_TO", "COMPETES_WITH", "CONFLICTS_WITH"]);

export function canonicalEndpoints(sourceId: string, targetId: string, type: RelationType): [string, string] {
  if (SYMMETRIC.has(type) && targetId < sourceId) return [targetId, sourceId];
  return [sourceId, targetId];
}

export async function lockOrgGraph(tx: DbClient, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kg:${orgId}`}))`;
}

// ---------------------------------------------------------------------------
// JSON shapes stored on rows
// ---------------------------------------------------------------------------

const mentionSchema = z.object({ documentId: z.string(), chunkId: z.string() });
const entityMetaSchema = z.object({
  mentions: z.array(mentionSchema).catch([]).default([]),
  mergedFrom: z.array(z.string()).catch([]).default([]),
});
export type EntityMeta = z.infer<typeof entityMetaSchema>;

export function parseEntityMeta(value: unknown): EntityMeta {
  const parsed = entityMetaSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : { mentions: [], mergedFrom: [] };
}

const quoteSchema = z.object({ documentId: z.string(), chunkId: z.string(), quote: z.string() });
export type EvidenceQuote = z.infer<typeof quoteSchema>;

export function parseQuotes(value: unknown): EvidenceQuote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const p = quoteSchema.safeParse(v);
    return p.success ? [p.data] : [];
  });
}

export const runOutputSchema = z.object({
  version: z.literal(1),
  documentId: z.string(),
  contentHash: z.string(),
  chunkCount: z.number(),
  processedChunks: z.number(),
  skippedChunks: z.number(),
  skipped: z.array(z.object({ chunkId: z.string(), reason: z.string() })),
  failedBatches: z.number(),
  unverifiedRelations: z.number(),
  entityMentions: z.record(z.string(), z.number()),
  relationIds: z.array(z.string()),
  evidenceChunkIds: z.array(z.string()),
  entityCount: z.number(),
  relationCount: z.number(),
  eventEmitted: z.boolean(),
  mergeSuggestions: z.number().optional(),
});
export type KnowledgeRunOutput = z.infer<typeof runOutputSchema>;

export function parseRunOutput(value: unknown): KnowledgeRunOutput | null {
  const p = runOutputSchema.safeParse(value);
  return p.success ? p.data : null;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface EntityWrite {
  name: string;
  normalizedName: string;
  type: EntityType;
  description: string | null;
  aliases: string[];
  confidence: number;
  mentions: number;
  chunkIds: string[];
}

function mergeAliases(existing: string[], incoming: string[], ownName: string): string[] {
  const own = ownName.toLowerCase();
  return uniqueCapped(
    [...existing, ...incoming].filter((a) => a.toLowerCase() !== own),
    MAX_ALIASES_STORED,
    (a) => a.toLowerCase()
  );
}

/**
 * Resolve an extracted entity to an existing one (exact key, then a
 * case-insensitive alias match left by an accepted merge or extraction), or
 * create it. Returns the entity ID. Caller holds the org lock.
 */
export async function upsertEntity(tx: DbClient, orgId: string, documentId: string, e: EntityWrite, now: Date): Promise<string> {
  const select = { id: true, name: true, aliases: true, description: true, confidence: true, metadata: true } as const;
  let existing = await tx.knowledgeEntity.findUnique({
    where: { orgId_normalizedName_type: { orgId, normalizedName: e.normalizedName, type: e.type } },
    select,
  });
  if (!existing) {
    const candidates = [e.normalizedName, e.name.toLowerCase()];
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM knowledge_entities
      WHERE "orgId" = ${orgId}
        AND EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = ANY(${candidates}))
      ORDER BY (type::text = ${e.type}) DESC, "mentionCount" DESC, id ASC
      LIMIT 1`;
    if (rows[0]) existing = await tx.knowledgeEntity.findFirst({ where: { id: rows[0].id, orgId }, select });
  }

  const newMentions = e.chunkIds.map((chunkId) => ({ documentId, chunkId }));
  if (existing) {
    const meta = parseEntityMeta(existing.metadata);
    meta.mentions = uniqueCapped(
      [...newMentions, ...meta.mentions.filter((m) => m.documentId !== documentId)],
      MAX_ENTITY_MENTIONS_STORED,
      (m) => m.chunkId
    );
    await tx.knowledgeEntity.update({
      where: { id: existing.id },
      data: {
        mentionCount: { increment: e.mentions },
        lastSeenAt: now,
        confidence: Math.max(existing.confidence, e.confidence),
        description: existing.description ?? e.description,
        aliases: mergeAliases(existing.aliases, e.name !== existing.name ? [e.name, ...e.aliases] : e.aliases, existing.name),
        metadata: meta as Prisma.InputJsonValue,
      },
    });
    return existing.id;
  }

  const created = await tx.knowledgeEntity.create({
    data: {
      orgId,
      type: e.type,
      name: e.name,
      normalizedName: e.normalizedName,
      aliases: mergeAliases([], e.aliases, e.name),
      description: e.description,
      confidence: e.confidence,
      mentionCount: e.mentions,
      firstSeenAt: now,
      lastSeenAt: now,
      metadata: { mentions: newMentions.slice(0, MAX_ENTITY_MENTIONS_STORED), mergedFrom: [] },
    },
    select: { id: true },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export interface RelationWrite {
  sourceId: string;
  targetId: string;
  type: RelationType;
  strength: number;
  evidence: Array<{ chunkId: string; quote: string }>;
}

/** Upsert on (sourceId, targetId, type), merging this document's evidence. Returns the relation ID. */
export async function upsertRelation(tx: DbClient, documentId: string, r: RelationWrite, now: Date): Promise<string> {
  const [sourceId, targetId] = canonicalEndpoints(r.sourceId, r.targetId, r.type);
  const quotes: EvidenceQuote[] = r.evidence.map((ev) => ({ documentId, chunkId: ev.chunkId, quote: ev.quote }));
  const chunkIds = r.evidence.map((ev) => ev.chunkId);
  const existing = await tx.knowledgeRelation.findUnique({
    where: { sourceId_targetId_type: { sourceId, targetId, type: r.type } },
    select: { id: true, strength: true, evidenceDocuments: true, evidenceChunkIds: true, evidenceQuotes: true },
  });
  if (existing) {
    const others = parseQuotes(existing.evidenceQuotes).filter((q) => q.documentId !== documentId);
    await tx.knowledgeRelation.update({
      where: { id: existing.id },
      data: {
        strength: Math.max(existing.strength, r.strength),
        evidenceDocuments: uniqueCapped([documentId, ...existing.evidenceDocuments], MAX_RELATION_DOCUMENTS),
        evidenceChunkIds: uniqueCapped([...chunkIds, ...existing.evidenceChunkIds], MAX_RELATION_CHUNK_IDS),
        evidenceQuotes: [...quotes, ...others].slice(0, MAX_RELATION_QUOTES) as Prisma.InputJsonValue,
        lastSeenAt: now,
      },
    });
    return existing.id;
  }
  const created = await tx.knowledgeRelation.create({
    data: {
      sourceId,
      targetId,
      type: r.type,
      strength: r.strength,
      evidenceDocuments: [documentId],
      evidenceChunkIds: uniqueCapped(chunkIds, MAX_RELATION_CHUNK_IDS),
      evidenceQuotes: quotes.slice(0, MAX_RELATION_QUOTES) as Prisma.InputJsonValue,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    select: { id: true },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Reverting a document's previous contribution
// ---------------------------------------------------------------------------

/** Find the entity an ID now lives in (itself, or the survivor of a merge). */
async function resolveEntityId(tx: DbClient, orgId: string, id: string): Promise<string | null> {
  const self = await tx.knowledgeEntity.findFirst({ where: { id, orgId }, select: { id: true } });
  if (self) return self.id;
  const survivor = await tx.knowledgeEntity.findFirst({
    where: { orgId, metadata: { path: ["mergedFrom"], array_contains: [id] } },
    select: { id: true },
  });
  return survivor?.id ?? null;
}

/**
 * Undo a document's recorded contribution: decrement mention counts, drop its
 * mentions and evidence, and delete relations left with no evidence. Returns
 * the (resolved) entity IDs that were decremented. Caller holds the org lock.
 */
export async function revertContribution(
  tx: DbClient,
  orgId: string,
  documentId: string,
  prev: Pick<KnowledgeRunOutput, "entityMentions" | "relationIds" | "evidenceChunkIds">
): Promise<Set<string>> {
  const decrements = new Map<string, number>();
  for (const [id, n] of Object.entries(prev.entityMentions)) {
    const resolved = await resolveEntityId(tx, orgId, id);
    if (resolved) decrements.set(resolved, (decrements.get(resolved) ?? 0) + n);
  }
  if (decrements.size > 0) {
    const rows = await tx.knowledgeEntity.findMany({
      where: { id: { in: [...decrements.keys()] }, orgId },
      select: { id: true, mentionCount: true, metadata: true },
    });
    for (const row of rows) {
      const meta = parseEntityMeta(row.metadata);
      meta.mentions = meta.mentions.filter((m) => m.documentId !== documentId);
      await tx.knowledgeEntity.update({
        where: { id: row.id },
        data: {
          mentionCount: Math.max(0, row.mentionCount - (decrements.get(row.id) ?? 0)),
          metadata: meta as Prisma.InputJsonValue,
        },
      });
    }
  }

  if (prev.relationIds.length > 0) {
    const chunkSet = new Set(prev.evidenceChunkIds);
    const rels = await tx.knowledgeRelation.findMany({
      where: { id: { in: prev.relationIds }, source: { orgId }, target: { orgId } },
      select: { id: true, evidenceDocuments: true, evidenceChunkIds: true, evidenceQuotes: true },
    });
    const toDelete: string[] = [];
    for (const r of rels) {
      const docs = r.evidenceDocuments.filter((d) => d !== documentId);
      if (docs.length === 0) {
        toDelete.push(r.id);
        continue;
      }
      await tx.knowledgeRelation.update({
        where: { id: r.id },
        data: {
          evidenceDocuments: docs,
          evidenceChunkIds: r.evidenceChunkIds.filter((c) => !chunkSet.has(c)),
          evidenceQuotes: parseQuotes(r.evidenceQuotes).filter((q) => q.documentId !== documentId) as Prisma.InputJsonValue,
        },
      });
    }
    if (toDelete.length > 0) await tx.knowledgeRelation.deleteMany({ where: { id: { in: toDelete } } });
  }
  return new Set(decrements.keys());
}

// ---------------------------------------------------------------------------
// Merging two entities (human-approved only)
// ---------------------------------------------------------------------------

/**
 * Merge `sourceId` into `targetId` within `orgId`: re-point relations (merging
 * evidence where the target already has the same relation, dropping would-be
 * self-loops), copy project links, sum mention counts, record aliases and the
 * merged ID, then delete the source. Both entities must belong to the org.
 * Caller holds the org lock (use inside a transaction).
 */
export async function mergeEntitiesInTx(tx: DbClient, orgId: string, sourceId: string, targetId: string): Promise<void> {
  if (sourceId === targetId) throw new Error("Cannot merge an entity into itself");
  const select = {
    id: true,
    name: true,
    aliases: true,
    description: true,
    confidence: true,
    mentionCount: true,
    firstSeenAt: true,
    lastSeenAt: true,
    metadata: true,
  } as const;
  const [source, target] = await Promise.all([
    tx.knowledgeEntity.findFirst({ where: { id: sourceId, orgId }, select }),
    tx.knowledgeEntity.findFirst({ where: { id: targetId, orgId }, select }),
  ]);
  if (!source || !target) throw new MergeNotFoundError();

  // Relations between the two would become self-loops.
  await tx.knowledgeRelation.deleteMany({
    where: {
      OR: [
        { sourceId, targetId },
        { sourceId: targetId, targetId: sourceId },
      ],
    },
  });

  const relSelect = {
    id: true,
    sourceId: true,
    targetId: true,
    type: true,
    strength: true,
    evidenceDocuments: true,
    evidenceChunkIds: true,
    evidenceQuotes: true,
    firstSeenAt: true,
    lastSeenAt: true,
  } as const;
  const moving = await tx.knowledgeRelation.findMany({
    where: { OR: [{ sourceId }, { targetId: sourceId }] },
    select: relSelect,
  });
  for (const r of moving) {
    const newSource = r.sourceId === sourceId ? targetId : r.sourceId;
    const newTarget = r.targetId === sourceId ? targetId : r.targetId;
    const [s, t] = canonicalEndpoints(newSource, newTarget, r.type);
    const clash = await tx.knowledgeRelation.findUnique({
      where: { sourceId_targetId_type: { sourceId: s, targetId: t, type: r.type } },
      select: relSelect,
    });
    if (clash && clash.id !== r.id) {
      await tx.knowledgeRelation.update({
        where: { id: clash.id },
        data: {
          strength: Math.max(clash.strength, r.strength),
          evidenceDocuments: uniqueCapped([...clash.evidenceDocuments, ...r.evidenceDocuments], MAX_RELATION_DOCUMENTS),
          evidenceChunkIds: uniqueCapped([...clash.evidenceChunkIds, ...r.evidenceChunkIds], MAX_RELATION_CHUNK_IDS),
          evidenceQuotes: uniqueCapped(
            [...parseQuotes(clash.evidenceQuotes), ...parseQuotes(r.evidenceQuotes)],
            MAX_RELATION_QUOTES,
            (q) => `${q.chunkId}:${q.quote}`
          ) as Prisma.InputJsonValue,
          firstSeenAt: clash.firstSeenAt < r.firstSeenAt ? clash.firstSeenAt : r.firstSeenAt,
          lastSeenAt: clash.lastSeenAt > r.lastSeenAt ? clash.lastSeenAt : r.lastSeenAt,
        },
      });
      await tx.knowledgeRelation.delete({ where: { id: r.id } });
    } else {
      await tx.knowledgeRelation.update({ where: { id: r.id }, data: { sourceId: s, targetId: t } });
    }
  }

  const links = await tx.knowledgeNode_Project.findMany({ where: { entityId: sourceId }, select: { projectId: true } });
  if (links.length > 0) {
    await tx.knowledgeNode_Project.createMany({
      data: links.map((l) => ({ entityId: targetId, projectId: l.projectId })),
      skipDuplicates: true,
    });
  }

  const sMeta = parseEntityMeta(source.metadata);
  const tMeta = parseEntityMeta(target.metadata);
  const merged: EntityMeta = {
    mentions: uniqueCapped([...tMeta.mentions, ...sMeta.mentions], MAX_ENTITY_MENTIONS_STORED, (m) => m.chunkId),
    mergedFrom: uniqueCapped([sourceId, ...sMeta.mergedFrom, ...tMeta.mergedFrom], MAX_MERGED_FROM),
  };
  await tx.knowledgeEntity.update({
    where: { id: targetId },
    data: {
      mentionCount: target.mentionCount + source.mentionCount,
      aliases: mergeAliases(target.aliases, [source.name, ...source.aliases], target.name),
      description: target.description ?? source.description,
      confidence: Math.max(target.confidence, source.confidence),
      firstSeenAt: target.firstSeenAt < source.firstSeenAt ? target.firstSeenAt : source.firstSeenAt,
      lastSeenAt: target.lastSeenAt > source.lastSeenAt ? target.lastSeenAt : source.lastSeenAt,
      metadata: merged as Prisma.InputJsonValue,
    },
  });
  // Cascades the source's project links and merge suggestions.
  await tx.knowledgeEntity.delete({ where: { id: sourceId } });
}

export class MergeNotFoundError extends Error {
  constructor() {
    super("Entity not found");
    this.name = "MergeNotFoundError";
  }
}
