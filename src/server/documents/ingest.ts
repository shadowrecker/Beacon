/**
 * Document ingestion entry points shared by every source (uploads, URL imports,
 * integrations, voice, quick capture).
 *
 * Text that a source already provides (integration records, transcripts) is
 * stored as `processedText` and the document is queued for chunking/embedding.
 * Integration records are idempotent on (integrationId, externalId): a re-sync
 * updates the existing document instead of creating a duplicate.
 */
import type { DocumentSource, DocumentType, Prisma } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { enqueue, QUEUE } from "../jobs/queues";
import { emitEvent } from "../events/bus";

export interface TextDocumentInput {
  projectId: string;
  title: string;
  type: DocumentType;
  source: DocumentSource;
  text: string;
  mimeType?: string;
  sourceUrl?: string | null;
  integrationId?: string | null;
  externalId?: string | null;
  createdById?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Max characters of text accepted from a single source record. */
export const MAX_INGEST_CHARS = 2_000_000;

export async function createDocumentFromText(input: TextDocumentInput, db: DbClient = prisma): Promise<{ documentId: string; created: boolean }> {
  const text = input.text.slice(0, MAX_INGEST_CHARS);
  const title = input.title.trim().slice(0, 300) || "Untitled";
  const data = {
    title,
    type: input.type,
    source: input.source,
    mimeType: input.mimeType ?? "text/plain",
    sourceUrl: input.sourceUrl ?? null,
    processedText: text,
    metadata: input.metadata,
    status: "PENDING" as const,
    errorMessage: null,
  };

  let documentId: string;
  let created: boolean;
  if (input.integrationId && input.externalId) {
    const existing = await db.document.findUnique({
      where: { integrationId_externalId: { integrationId: input.integrationId, externalId: input.externalId } },
      select: { id: true, processedText: true },
    });
    if (existing && existing.processedText === text) {
      return { documentId: existing.id, created: false }; // unchanged record: nothing to do
    }
    const doc = await db.document.upsert({
      where: { integrationId_externalId: { integrationId: input.integrationId, externalId: input.externalId } },
      update: data,
      create: {
        ...data,
        projectId: input.projectId,
        integrationId: input.integrationId,
        externalId: input.externalId,
        createdById: input.createdById ?? null,
      },
      select: { id: true },
    });
    documentId = doc.id;
    created = !existing;
  } else {
    const doc = await db.document.create({
      data: { ...data, projectId: input.projectId, createdById: input.createdById ?? null },
      select: { id: true },
    });
    documentId = doc.id;
    created = true;
  }

  await enqueue(QUEUE.DOCUMENTS, { documentId }, { jobId: `doc_${documentId}_${Date.now()}` });

  if (created) {
    const project = await db.project.findUnique({ where: { id: input.projectId }, select: { orgId: true } });
    if (project) {
      await emitEvent(
        {
          orgId: project.orgId,
          projectId: input.projectId,
          type: "document.uploaded",
          payload: { documentId, title, source: input.source },
          actorUserId: input.createdById ?? null,
        },
        db
      );
    }
  }
  return { documentId, created };
}
