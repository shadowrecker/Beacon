/**
 * Knowledge extraction for one document (QUEUE.KNOWLEDGE).
 *
 * 1. Load the document's chunks (scoped to its project) and fingerprint them.
 *    If this exact content was already applied, skip extraction (idempotent).
 * 2. Extract entities/relations per bounded chunk batch on the bulk model.
 *    Every chunk is either processed or recorded as skipped with a reason.
 * 3. In one transaction under the org lock: revert the document's previous
 *    contribution, upsert entities (mention counts), project links and
 *    relations (verified evidence), and record the new contribution.
 * 4. Embed new entities, look for likely duplicates (ANN within the org, same
 *    embedding model) and record merge suggestions (never auto-merge), emit
 *    knowledge.extracted, and mark the run READY.
 *
 * Tracking row: one JobRun per document with a deterministic ID, so the
 * subscriber (producer) and this worker always refer to the same row.
 */
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import type { Logger } from "@/lib/logger";
import { NonRetryableError } from "../../jobs/worker";
import { emitEvent } from "../../events/bus";
import { LLMError } from "../client";
import { embeddingModel, embedTexts, toVectorLiteral } from "../embeddings";
import { extractBatch, MAX_CHUNK_CHARS, planBatches, type BatchExtraction, type BatchChunk } from "./extract";
import {
  lockOrgGraph,
  parseRunOutput,
  revertContribution,
  upsertEntity,
  upsertRelation,
  type EntityWrite,
  type KnowledgeRunOutput,
} from "./store";
import { suggestMerges } from "./duplicates";
import { uniqueCapped } from "./text";

/** Chunks beyond this per document are recorded as skipped ("document_chunk_limit"). */
export const MAX_CHUNKS_PER_DOCUMENT = 400;
const MAX_SKIPPED_LISTED = 200;
const MAX_CHUNK_IDS_PER_ENTITY = 50;
const MAX_EVIDENCE_PER_RELATION = 10;
const BATCH_CACHE_TTL_SEC = 24 * 3600;

export function knowledgeRunId(documentId: string): string {
  return `kg_${documentId}`;
}

export interface ProcessResult {
  status: "applied" | "unchanged";
  entityCount: number;
  relationCount: number;
  skippedChunks: number;
  mergeSuggestions: number;
}

interface MergedEntity extends EntityWrite {
  key: string;
}

interface MergedRelation {
  sourceKey: string;
  targetKey: string;
  type: BatchExtraction["relations"][number]["type"];
  strength: number;
  evidence: Array<{ chunkId: string; quote: string }>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function fingerprint(chunks: Array<{ id: string; content: string }>): string {
  const h = createHash("sha256");
  for (const c of chunks) h.update(`${c.id}\u0000${sha256(c.content)}\n`);
  return h.digest("hex");
}

/** Aggregate per-batch extractions into one entity/relation set for the document. */
export function mergeExtractions(results: BatchExtraction[]): { entities: MergedEntity[]; relations: MergedRelation[]; unverified: number } {
  const entities = new Map<string, MergedEntity>();
  const relations = new Map<string, MergedRelation>();
  let unverified = 0;
  for (const r of results) {
    unverified += r.unverifiedRelations;
    for (const e of r.entities) {
      const existing = entities.get(e.key);
      if (existing) {
        existing.chunkIds = uniqueCapped([...existing.chunkIds, ...e.chunkIds], MAX_CHUNK_IDS_PER_ENTITY);
        existing.aliases = uniqueCapped([...existing.aliases, ...e.aliases], 10, (a) => a.toLowerCase());
        existing.confidence = Math.max(existing.confidence, e.confidence);
        existing.description ??= e.description;
      } else {
        entities.set(e.key, {
          key: e.key,
          name: e.name,
          normalizedName: e.normalizedName,
          type: e.type,
          description: e.description,
          aliases: e.aliases,
          confidence: e.confidence,
          chunkIds: e.chunkIds.slice(0, MAX_CHUNK_IDS_PER_ENTITY),
          mentions: 0,
        });
      }
    }
    for (const rel of r.relations) {
      const key = `${rel.sourceKey}>${rel.targetKey}>${rel.type}`;
      const existing = relations.get(key);
      if (existing) {
        existing.strength = Math.max(existing.strength, rel.strength);
        existing.evidence = uniqueCapped([...existing.evidence, ...rel.evidence], MAX_EVIDENCE_PER_RELATION, (x) => `${x.chunkId}:${x.quote}`);
      } else {
        relations.set(key, { ...rel, evidence: rel.evidence.slice(0, MAX_EVIDENCE_PER_RELATION) });
      }
    }
  }
  for (const e of entities.values()) e.mentions = Math.max(1, e.chunkIds.length);
  return { entities: [...entities.values()], relations: [...relations.values()], unverified };
}

/** Per-batch result cache so a retried job does not pay for batches it already extracted. */
async function extractBatchCached(batch: BatchChunk[], ctx: { orgId: string; projectId: string; documentLabel: string }, log: Logger): Promise<BatchExtraction> {
  const key = `kg:batch:${fingerprint(batch)}`;
  try {
    const hit = await getRedis().get(key);
    if (hit) return JSON.parse(hit) as BatchExtraction;
  } catch (err) {
    log.warn("knowledge batch cache unavailable", { err });
  }
  const result = await extractBatch(batch, ctx);
  try {
    await getRedis().set(key, JSON.stringify(result), "EX", BATCH_CACHE_TTL_SEC);
  } catch {
    /* cache is best-effort */
  }
  return result;
}

export async function processDocumentKnowledge(
  documentId: string,
  log: Logger,
  onProgress: (pct: number) => Promise<void> = async () => undefined
): Promise<ProcessResult> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, title: true, status: true, projectId: true, project: { select: { orgId: true } } },
  });
  if (!doc) throw new NonRetryableError("Document not found");
  const orgId = doc.project.orgId;
  const projectId = doc.projectId;
  const runId = knowledgeRunId(documentId);
  const now = new Date();

  const existingRun = await prisma.jobRun.findUnique({ where: { id: runId }, select: { output: true } });
  await prisma.jobRun.upsert({
    where: { id: runId },
    create: {
      id: runId,
      kind: "KNOWLEDGE_EXTRACTION",
      orgId,
      projectId,
      status: "PROCESSING",
      input: { documentId },
      startedAt: now,
    },
    update: { status: "PROCESSING", startedAt: now, completedAt: null, errorMessage: null },
  });
  if (doc.status !== "READY") throw new NonRetryableError("The document is not ready for knowledge extraction");

  const chunks = await prisma.chunk.findMany({
    where: { documentId, projectId },
    orderBy: { position: "asc" },
    select: { id: true, content: true },
  });
  const contentHash = fingerprint(chunks);
  let output = parseRunOutput(existingRun?.output);
  let status: ProcessResult["status"] = "unchanged";

  if (output?.contentHash !== contentHash) {
    status = "applied";
    const skipped: Array<{ chunkId: string; reason: string }> = [];
    const eligible: BatchChunk[] = [];
    for (const c of chunks) {
      if (!c.content.trim()) skipped.push({ chunkId: c.id, reason: "empty" });
      else if (c.content.length > MAX_CHUNK_CHARS) skipped.push({ chunkId: c.id, reason: "chunk_too_large" });
      else if (eligible.length >= MAX_CHUNKS_PER_DOCUMENT) skipped.push({ chunkId: c.id, reason: "document_chunk_limit" });
      else eligible.push(c);
    }

    const batches = planBatches(eligible);
    const results: BatchExtraction[] = [];
    let failedBatches = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        results.push(await extractBatchCached(batch, { orgId, projectId, documentLabel: doc.title }, log));
      } catch (err) {
        // Model-level failures (refusal, truncation, schema mismatch) skip the batch and are recorded.
        // Anything else (budget, network, 5xx) fails the job so it can be retried as a whole.
        if (!(err instanceof LLMError)) throw err;
        failedBatches++;
        for (const c of batch) skipped.push({ chunkId: c.id, reason: `extraction_failed:${err.reason}` });
        log.warn("knowledge batch failed; chunks recorded as skipped", { documentId, batch: i, reason: err.reason });
      }
      await onProgress(((i + 1) / Math.max(1, batches.length)) * 80);
    }
    if (batches.length > 0 && results.length === 0) {
      throw new NonRetryableError("Knowledge extraction failed for every part of this document");
    }

    const merged = mergeExtractions(results);
    output = await applyToGraph({
      orgId,
      projectId,
      documentId,
      runId,
      contentHash,
      merged,
      stats: {
        chunkCount: chunks.length,
        processedChunks: eligible.length - failedBatchesChunkCount(skipped),
        skipped,
        failedBatches,
      },
    });
  }

  if (!output) throw new Error("Knowledge run output missing after apply");

  const touched = Object.keys(output.entityMentions);
  await ensureEntityEmbeddings(orgId, projectId, touched);
  const mergeSuggestions = await suggestMerges(orgId, touched, log);
  await onProgress(95);

  if (!output.eventEmitted) {
    await emitEvent({
      orgId,
      projectId,
      type: "knowledge.extracted",
      payload: { documentId, entityCount: output.entityCount, relationCount: output.relationCount },
    });
    output = { ...output, eventEmitted: true };
  }
  output = { ...output, mergeSuggestions: (output.mergeSuggestions ?? 0) + mergeSuggestions };
  await prisma.jobRun.update({
    where: { id: runId },
    data: { status: "READY", output: output as Prisma.InputJsonValue, completedAt: new Date(), errorMessage: null },
  });

  return {
    status,
    entityCount: output.entityCount,
    relationCount: output.relationCount,
    skippedChunks: output.skippedChunks,
    mergeSuggestions,
  };
}

function failedBatchesChunkCount(skipped: Array<{ reason: string }>): number {
  return skipped.filter((s) => s.reason.startsWith("extraction_failed")).length;
}

async function applyToGraph(input: {
  orgId: string;
  projectId: string;
  documentId: string;
  runId: string;
  contentHash: string;
  merged: ReturnType<typeof mergeExtractions>;
  stats: { chunkCount: number; processedChunks: number; skipped: Array<{ chunkId: string; reason: string }>; failedBatches: number };
}): Promise<KnowledgeRunOutput> {
  const { orgId, projectId, documentId, runId, contentHash, merged, stats } = input;
  return prisma.$transaction(
    async (tx) => {
      await lockOrgGraph(tx, orgId);
      // Re-read under the lock: a concurrent job may already have applied this content.
      const run = await tx.jobRun.findUnique({ where: { id: runId }, select: { output: true } });
      const prev = parseRunOutput(run?.output);
      if (prev?.contentHash === contentHash) return prev;

      const reverted = prev ? await revertContribution(tx, orgId, documentId, prev) : new Set<string>();

      const now = new Date();
      const idByKey = new Map<string, string>();
      const entityMentions: Record<string, number> = {};
      for (const e of merged.entities) {
        const id = await upsertEntity(tx, orgId, documentId, e, now);
        idByKey.set(e.key, id);
        entityMentions[id] = (entityMentions[id] ?? 0) + e.mentions;
      }
      const entityIds = [...new Set(idByKey.values())];
      if (entityIds.length > 0) {
        await tx.knowledgeNode_Project.createMany({
          data: entityIds.map((entityId) => ({ entityId, projectId })),
          skipDuplicates: true,
        });
      }

      const relationIds = new Set<string>();
      const evidenceChunkIds = new Set<string>();
      for (const r of merged.relations) {
        const sourceId = idByKey.get(r.sourceKey);
        const targetId = idByKey.get(r.targetKey);
        if (!sourceId || !targetId || sourceId === targetId) continue;
        const id = await upsertRelation(tx, documentId, { sourceId, targetId, type: r.type, strength: r.strength, evidence: r.evidence }, now);
        relationIds.add(id);
        for (const ev of r.evidence) evidenceChunkIds.add(ev.chunkId);
      }

      // Entities that only this document mentioned before, and no longer does.
      const stale = [...reverted].filter((id) => !(id in entityMentions));
      if (stale.length > 0) {
        await tx.knowledgeEntity.deleteMany({ where: { id: { in: stale }, orgId, mentionCount: { lte: 0 } } });
      }

      const output: KnowledgeRunOutput = {
        version: 1,
        documentId,
        contentHash,
        chunkCount: stats.chunkCount,
        processedChunks: Math.max(0, stats.processedChunks),
        skippedChunks: stats.skipped.length,
        skipped: stats.skipped.slice(0, MAX_SKIPPED_LISTED),
        failedBatches: stats.failedBatches,
        unverifiedRelations: merged.unverified,
        entityMentions,
        relationIds: [...relationIds],
        evidenceChunkIds: [...evidenceChunkIds],
        entityCount: entityIds.length,
        relationCount: relationIds.size,
        eventEmitted: false,
      };
      await tx.jobRun.update({ where: { id: runId }, data: { output: output as Prisma.InputJsonValue } });
      return output;
    },
    { timeout: 120_000, maxWait: 30_000 }
  );
}

function entityEmbeddingText(e: { name: string; type: string; description: string | null }): string {
  const type = e.type.toLowerCase().replace(/_/g, " ");
  return e.description ? `${e.name} (${type}): ${e.description}` : `${e.name} (${type})`;
}

/** Embed entities that have no vector for the current embedding model. Returns how many were written. */
export async function ensureEntityEmbeddings(orgId: string, projectId: string | null, entityIds: string[]): Promise<number> {
  if (entityIds.length === 0) return 0;
  const model = embeddingModel();
  let written = 0;
  for (let offset = 0; offset < entityIds.length; offset += 500) {
    const ids = entityIds.slice(offset, offset + 500);
    const rows = await prisma.$queryRaw<Array<{ id: string; name: string; type: string; description: string | null }>>`
      SELECT id, name, type::text AS type, description FROM knowledge_entities
      WHERE "orgId" = ${orgId} AND id = ANY(${ids})
        AND (embedding IS NULL OR "embeddingModel" IS DISTINCT FROM ${model})`;
    if (rows.length === 0) continue;
    const { vectors, model: used } = await embedTexts(rows.map(entityEmbeddingText), {
      feature: "knowledge.embed",
      orgId,
      projectId,
    });
    for (let i = 0; i < rows.length; i++) {
      const v = vectors[i];
      if (!v) continue;
      await prisma.$executeRaw`
        UPDATE knowledge_entities SET embedding = ${toVectorLiteral(v)}::vector, "embeddingModel" = ${used}
        WHERE id = ${rows[i].id} AND "orgId" = ${orgId}`;
      written++;
    }
  }
  return written;
}

/**
 * Remove a document's contribution from the graph (for document deletion or
 * re-scoping). Entities left with no mentions are deleted.
 */
export async function removeDocumentKnowledge(documentId: string): Promise<void> {
  const runId = knowledgeRunId(documentId);
  const run = await prisma.jobRun.findUnique({ where: { id: runId }, select: { orgId: true, output: true } });
  if (!run) return;
  const prev = parseRunOutput(run.output);
  await prisma.$transaction(
    async (tx) => {
      await lockOrgGraph(tx, run.orgId);
      if (prev) {
        const reverted = await revertContribution(tx, run.orgId, documentId, prev);
        if (reverted.size > 0) {
          await tx.knowledgeEntity.deleteMany({ where: { id: { in: [...reverted] }, orgId: run.orgId, mentionCount: { lte: 0 } } });
        }
      }
      await tx.jobRun.deleteMany({ where: { id: runId } });
    },
    { timeout: 60_000, maxWait: 30_000 }
  );
}
