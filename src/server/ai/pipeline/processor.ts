/**
 * Document processing: parse → chunk → embed → store, for one Document row.
 *
 * - Updates the same Document row the producer created (PENDING → PROCESSING →
 *   READY), never a second tracking row.
 * - Idempotent: the document's chunks are replaced in one transaction
 *   (delete-then-insert keyed by documentId), so a retried job never duplicates
 *   chunks.
 * - Embeddings are written with parameterized raw SQL (`::vector` casts) along
 *   with the model name; chunks carry the denormalized projectId used by RAG.
 * - Emits document.ready, or document.failed from markDocumentFailed (called by
 *   the worker's onFinalFailure).
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { emitEvent } from "@/server/events/bus";
import { failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { embedTexts, toVectorLiteral } from "../embeddings";
import { FEATURES } from "../prompts";
import { chunkText } from "./chunker";
import { extractDocument } from "./parser";

const INSERT_BATCH = 500;
const EMBEDDING_UPDATE_BATCH = 50;

function asObject(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, Prisma.JsonValue>) : {};
}

export interface ProcessResult {
  chunkCount: number;
}

export async function processDocument(documentId: string, log: Logger): Promise<ProcessResult | null> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      projectId: true,
      title: true,
      mimeType: true,
      storageKey: true,
      processedText: true,
      metadata: true,
      createdById: true,
      project: { select: { orgId: true } },
    },
  });
  if (!doc) {
    log.warn("document no longer exists; skipping", { documentId });
    return null;
  }
  const orgId = doc.project.orgId;

  await prisma.document.update({
    where: { id: doc.id },
    data: { status: "PROCESSING", processingStartedAt: new Date(), processingCompletedAt: null, errorMessage: null },
  });

  const parsed = await extractDocument({
    projectId: doc.projectId,
    mimeType: doc.mimeType,
    storageKey: doc.storageKey,
    processedText: doc.processedText,
    ctx: { feature: FEATURES.documentTranscribe, orgId, projectId: doc.projectId },
  });
  const chunks = chunkText(parsed.text, parsed.segments);
  if (chunks.length === 0) throw new NonRetryableError("No text could be extracted from this document");

  const { vectors, model } = await embedTexts(
    chunks.map((c) => c.content),
    { feature: FEATURES.documentEmbed, orgId, projectId: doc.projectId }
  );

  const processing = {
    chunkCount: chunks.length,
    characters: parsed.text.length,
    truncated: parsed.truncated,
    originalCharacters: parsed.originalChars,
    ...parsed.info,
  };

  const stored = await prisma.$transaction(
    async (tx) => {
      const still = await tx.document.findUnique({ where: { id: doc.id }, select: { id: true } });
      if (!still) return false;

      await tx.chunk.deleteMany({ where: { documentId: doc.id } });
      const ids: string[] = new Array(chunks.length);
      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const batch = chunks.slice(i, i + INSERT_BATCH);
        const rows = await tx.chunk.createManyAndReturn({
          data: batch.map((c) => ({
            documentId: doc.id,
            projectId: doc.projectId,
            content: c.content,
            position: c.position,
            startOffset: c.startOffset,
            endOffset: c.endOffset,
            tokenCount: c.tokenCount,
            metadata: c.metadata as Prisma.InputJsonValue,
          })),
          select: { id: true, position: true },
        });
        for (const r of rows) ids[r.position] = r.id;
      }

      const pairs = chunks
        .map((c, i) => ({ id: ids[c.position], vector: vectors[i] }))
        .filter((p): p is { id: string; vector: number[] } => Boolean(p.id && p.vector));
      for (let i = 0; i < pairs.length; i += EMBEDDING_UPDATE_BATCH) {
        const values = pairs
          .slice(i, i + EMBEDDING_UPDATE_BATCH)
          .map((p) => Prisma.sql`(${p.id}, ${toVectorLiteral(p.vector)})`);
        await tx.$executeRaw`
          UPDATE chunks AS c
          SET embedding = v.embedding::vector, "embeddingModel" = ${model}
          FROM (VALUES ${Prisma.join(values)}) AS v(id, embedding)
          WHERE c.id = v.id AND c."documentId" = ${doc.id}`;
      }

      await tx.document.update({
        where: { id: doc.id },
        data: {
          status: "READY",
          processedText: parsed.text,
          errorMessage: null,
          processingCompletedAt: new Date(),
          metadata: { ...asObject(doc.metadata), processing } as Prisma.InputJsonValue,
        },
      });
      return true;
    },
    { timeout: 120_000, maxWait: 10_000 }
  );

  if (!stored) {
    log.warn("document deleted during processing; discarded results", { documentId });
    return null;
  }

  await emitEvent({
    orgId,
    projectId: doc.projectId,
    type: "document.ready",
    payload: { documentId: doc.id, title: doc.title, chunkCount: chunks.length },
    actorUserId: doc.createdById,
  });
  log.info("document processed", { documentId, chunks: chunks.length, truncated: parsed.truncated });
  return { chunkCount: chunks.length };
}

/** Final failure: move the row to FAILED with a presentable reason and emit document.failed. */
export async function markDocumentFailed(documentId: string, err: Error): Promise<void> {
  const message = failureMessage(err);
  const res = await prisma.document.updateMany({
    where: { id: documentId, status: { not: "READY" } },
    data: { status: "FAILED", errorMessage: message, processingCompletedAt: null },
  });
  if (res.count === 0) return;
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: { title: true, projectId: true, createdById: true, project: { select: { orgId: true } } },
  });
  if (!doc) return;
  await emitEvent({
    orgId: doc.project.orgId,
    projectId: doc.projectId,
    type: "document.failed",
    payload: { documentId, title: doc.title, error: message },
    actorUserId: doc.createdById,
  });
}
