/**
 * Documents: upload (presigned POST → confirm), URL import, listing, detail with
 * paginated chunks, download, retry and delete.
 *
 * The client never chooses where content is read from: object keys are
 * generated here (projectObjectKey, with the document id in the key), the MIME
 * type comes from the file's bytes (resolveUploadMime), and URL imports are
 * fetched server-side through safeFetch. Status changes are worker-only.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { DocumentStatus, Prisma } from "@prisma/client";
import { allowedTypeForFilename, ALLOWED_TYPES, resolveUploadMime } from "@/lib/file-types";
import { getStorage, keyBelongsToProject, projectObjectKey } from "@/lib/storage";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { logger } from "@/lib/logger";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { router, protectedProcedure, outboundProcedure, rateLimited } from "../trpc";
import { found, requireProjectAccess } from "../auth/access";
import { enqueue, QUEUE } from "../jobs/queues";
import { emitEvent } from "../events/bus";
import { createDocumentFromText } from "../documents/ingest";
import { decodeEntities, extractTitle, htmlToText } from "../ai/pipeline/html";
import { removeDocumentKnowledge } from "../ai/knowledge/pipeline";

const id = z.string().min(1).max(64);
const documentType = z.enum(["TRANSCRIPT", "SUPPORT_TICKET", "NOTE", "CALL_RECORDING", "OTHER"]);
const documentStatus = z.enum(["PENDING", "PROCESSING", "READY", "FAILED"]);
const title = z.string().trim().min(1).max(300);

/** Bytes read from the start of an upload for content sniffing. */
const SNIFF_BYTES = 8_192;
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const MIN_IMPORT_CHARS = 50;

type DocMetadata = { originalFilename?: string; awaitingUpload?: boolean; processing?: Record<string, unknown> } & Record<string, unknown>;

function metadataOf(value: Prisma.JsonValue | null): DocMetadata {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DocMetadata) : {};
}

function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const stem = base.replace(/\.[a-z0-9]{1,10}$/i, "").replace(/[_]+/g, " ").trim();
  return (stem || base).slice(0, 300);
}

const listSelect = {
  id: true,
  title: true,
  type: true,
  source: true,
  status: true,
  mimeType: true,
  fileSize: true,
  sourceUrl: true,
  errorMessage: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  processingCompletedAt: true,
  _count: { select: { chunks: true } },
} satisfies Prisma.DocumentSelect;

type ListRow = Prisma.DocumentGetPayload<{ select: typeof listSelect }>;

function toSummary(d: ListRow) {
  const meta = metadataOf(d.metadata);
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    source: d.source,
    status: d.status,
    mimeType: d.mimeType,
    fileSize: d.fileSize,
    sourceUrl: d.sourceUrl,
    errorMessage: d.errorMessage,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    processingCompletedAt: d.processingCompletedAt,
    chunkCount: d._count.chunks,
    awaitingUpload: meta.awaitingUpload === true,
    originalFilename: typeof meta.originalFilename === "string" ? meta.originalFilename : null,
  };
}

/** Plain text from an imported response, by content type. */
function textFromResponse(contentType: string, body: string): { text: string; title: string | null; mimeType: string } {
  if (contentType.includes("html") || contentType.includes("xml") || /^\s*<(!doctype html|html)\b/i.test(body)) {
    return { text: htmlToText(body), title: extractTitle(body), mimeType: "text/plain" };
  }
  if (contentType.startsWith("text/markdown")) return { text: body, title: null, mimeType: "text/markdown" };
  if (contentType.startsWith("text/")) return { text: body, title: null, mimeType: "text/plain" };
  if (contentType.includes("json")) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), title: null, mimeType: "text/plain" };
    } catch {
      return { text: body, title: null, mimeType: "text/plain" };
    }
  }
  throw new TRPCError({ code: "BAD_REQUEST", message: "That page isn't a supported format (HTML, text, Markdown or JSON)" });
}

export const documentRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        projectId: id,
        limit: z.number().int().min(1).max(100).default(25),
        cursor: id.nullish(),
        status: documentStatus.optional(),
        type: documentType.optional(),
        search: z.string().trim().max(200).optional(),
        sort: z.enum(["newest", "oldest", "title"]).default("newest"),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const where: Prisma.DocumentWhereInput = {
        projectId: project.id,
        ...(input.status ? { status: input.status as DocumentStatus } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.search ? { title: { contains: input.search, mode: "insensitive" } } : {}),
      };
      const orderBy: Prisma.DocumentOrderByWithRelationInput[] =
        input.sort === "title"
          ? [{ title: "asc" }, { id: "asc" }]
          : input.sort === "oldest"
            ? [{ createdAt: "asc" }, { id: "asc" }]
            : [{ createdAt: "desc" }, { id: "desc" }];
      const rows = await ctx.prisma.document.findMany({
        where,
        orderBy,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: listSelect,
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map(toSummary),
        nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
      };
    }),

  getById: protectedProcedure.input(z.object({ projectId: id, id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const doc = found(
      await ctx.prisma.document.findFirst({
        where: { id: input.id, projectId: project.id },
        select: { ...listSelect, storageKey: true, processingStartedAt: true, integration: { select: { provider: true } } },
      }),
      "Document"
    );
    const meta = metadataOf(doc.metadata);
    return {
      ...toSummary(doc),
      processingStartedAt: doc.processingStartedAt,
      hasFile: Boolean(doc.storageKey),
      integrationProvider: doc.integration?.provider ?? null,
      processing: meta.processing && typeof meta.processing === "object" ? (meta.processing as Record<string, string | number | boolean>) : null,
    };
  }),

  /** Chunks of one document in order, paginated by position (cursor = next position). */
  chunks: protectedProcedure
    .input(
      z.object({
        projectId: id,
        documentId: id,
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.number().int().min(0).max(1_000_000).nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const doc = found(
        await ctx.prisma.document.findFirst({ where: { id: input.documentId, projectId: project.id }, select: { id: true } }),
        "Document"
      );
      const rows = await ctx.prisma.chunk.findMany({
        where: { documentId: doc.id, projectId: project.id, position: { gte: input.cursor ?? 0 } },
        orderBy: { position: "asc" },
        take: input.limit + 1,
        select: { id: true, position: true, content: true, tokenCount: true, startOffset: true, endOffset: true, metadata: true },
      });
      const page = rows.slice(0, input.limit);
      return { items: page, nextCursor: rows.length > input.limit ? rows[input.limit].position : null };
    }),

  /** Step 1 of an upload: create the PENDING row and a presigned POST for its server-chosen key. */
  getUploadUrl: protectedProcedure
    .use(rateLimited(RATE_LIMITS.upload))
    .input(
      z.object({
        projectId: id,
        filename: z.string().trim().min(1).max(255),
        size: z.number().int().positive().max(Math.max(...ALLOWED_TYPES.map((t) => t.maxBytes))),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const allowed = allowedTypeForFilename(input.filename);
      if (!allowed) throw new TRPCError({ code: "BAD_REQUEST", message: "This file type is not supported" });
      if (input.size > allowed.maxBytes) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `This file is too large (the limit is ${Math.round(allowed.maxBytes / (1024 * 1024))} MB)` });
      }
      const doc = await ctx.prisma.document.create({
        data: {
          projectId: project.id,
          title: titleFromFilename(input.filename),
          type: allowed.category === "document" ? "OTHER" : "CALL_RECORDING",
          source: "UPLOAD",
          status: "PENDING",
          mimeType: allowed.mime,
          createdById: ctx.user.id,
          metadata: { originalFilename: input.filename, awaitingUpload: true },
        },
        select: { id: true },
      });
      const key = projectObjectKey(project.id, "documents", doc.id, input.filename);
      await ctx.prisma.document.update({ where: { id: doc.id }, data: { storageKey: key } });
      const upload = await getStorage().createUpload({ key, contentType: allowed.mime, maxBytes: allowed.maxBytes });
      return {
        documentId: doc.id,
        url: upload.url,
        fields: upload.fields,
        expiresAt: upload.expiresAt,
        contentType: allowed.mime,
        maxBytes: allowed.maxBytes,
      };
    }),

  /** Step 2 of an upload: verify the stored object and queue processing. */
  confirmUpload: protectedProcedure
    .use(rateLimited(RATE_LIMITS.upload))
    .input(z.object({ projectId: id, documentId: id, title: title.optional(), type: documentType }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const doc = found(
        await ctx.prisma.document.findFirst({
          where: { id: input.documentId, projectId: project.id, source: "UPLOAD" },
          select: { id: true, title: true, status: true, storageKey: true, metadata: true },
        }),
        "Document"
      );
      const meta = metadataOf(doc.metadata);
      if (meta.awaitingUpload !== true) {
        // Already confirmed (double submit): report the current state.
        return { id: doc.id, status: doc.status };
      }
      if (!doc.storageKey || !keyBelongsToProject(doc.storageKey, project.id)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This upload is not valid. Please upload the file again." });
      }
      const filename = meta.originalFilename ?? doc.storageKey.split("/").pop() ?? "";
      const storage = getStorage();
      const head = await storage.head(doc.storageKey);
      if (!head) throw new TRPCError({ code: "BAD_REQUEST", message: "The file hasn't finished uploading. Please try again." });

      const allowed = allowedTypeForFilename(filename);
      const sniff = head.size > 0 ? await storage.get(doc.storageKey, { range: [0, Math.min(head.size, SNIFF_BYTES) - 1] }) : Buffer.alloc(0);
      const resolved = resolveUploadMime(filename, sniff);
      const reject = async (message: string) => {
        await storage.delete(doc.storageKey!).catch((err) => logger.warn("failed to delete rejected upload", { err }));
        await ctx.prisma.document.delete({ where: { id: doc.id } });
        throw new TRPCError({ code: "BAD_REQUEST", message });
      };
      if (!allowed || head.size === 0) return reject("The uploaded file is empty or not a supported type");
      if (head.size > allowed.maxBytes) return reject("The uploaded file is larger than allowed");
      if (!resolved.ok) return reject(resolved.reason);

      const finalTitle = input.title ?? doc.title;
      const updated = await ctx.prisma.document.update({
        where: { id: doc.id },
        data: {
          title: finalTitle,
          type: input.type,
          mimeType: resolved.type.mime,
          fileSize: head.size,
          status: "PENDING",
          errorMessage: null,
          metadata: { ...meta, awaitingUpload: false, uploadedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        },
        select: { id: true, status: true },
      });
      await enqueue(QUEUE.DOCUMENTS, { documentId: doc.id }, { jobId: `doc_${doc.id}` });
      await emitEvent({
        orgId: project.orgId,
        projectId: project.id,
        type: "document.uploaded",
        payload: { documentId: doc.id, title: finalTitle, source: "UPLOAD" },
        actorUserId: ctx.user.id,
      });
      return updated;
    }),

  /** Import a web page (or text/Markdown/JSON URL) as a document. */
  importUrl: outboundProcedure
    .input(
      z.object({
        projectId: id,
        url: z.string().trim().url().max(2_048),
        title: title.optional(),
        type: documentType.default("OTHER"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      let res: Awaited<ReturnType<typeof safeFetch>>;
      try {
        res = await safeFetch(input.url, {
          maxBytes: IMPORT_MAX_BYTES,
          timeoutMs: 15_000,
          headers: { accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1" },
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          const message =
            err.code === "RESPONSE_TOO_LARGE"
              ? "That page is too large to import (the limit is 5 MB)"
              : err.code === "TIMEOUT"
                ? "That page took too long to respond"
                : err.code === "BLOCKED_ADDRESS" || err.code === "BLOCKED_PROTOCOL"
                  ? "That address can't be imported. Use a public https:// URL."
                  : "That page couldn't be fetched";
          throw new TRPCError({ code: "BAD_REQUEST", message });
        }
        throw err;
      }
      if (!res.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `That page returned HTTP ${res.status}` });

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const extracted = textFromResponse(contentType, res.text());
      const text = extracted.text.trim();
      if (text.length < MIN_IMPORT_CHARS) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That page doesn't contain enough readable text to import" });
      }
      const finalUrl = res.url;
      const docTitle = input.title ?? (extracted.title ? decodeEntities(extracted.title) : null) ?? new URL(finalUrl).hostname;
      const { documentId } = await createDocumentFromText({
        projectId: project.id,
        title: docTitle,
        type: input.type,
        source: "URL",
        text,
        mimeType: extracted.mimeType,
        sourceUrl: finalUrl.slice(0, 2_048),
        createdById: ctx.user.id,
        metadata: { importedAt: new Date().toISOString(), contentType: contentType.slice(0, 100) },
      });
      return { id: documentId };
    }),

  /** Short-lived download link for the original file. */
  getDownloadUrl: protectedProcedure.input(z.object({ projectId: id, id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "data:export");
    const doc = found(
      await ctx.prisma.document.findFirst({
        where: { id: input.id, projectId: project.id },
        select: { storageKey: true, metadata: true, title: true },
      }),
      "Document"
    );
    if (!doc.storageKey || !keyBelongsToProject(doc.storageKey, project.id)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This document has no stored file" });
    }
    const meta = metadataOf(doc.metadata);
    const url = await getStorage().presignGet(doc.storageKey, {
      expiresInSec: 300,
      downloadName: meta.originalFilename ?? doc.title,
    });
    return { url };
  }),

  /** Re-queue a FAILED document. */
  retry: protectedProcedure.input(z.object({ projectId: id, id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    const doc = found(
      await ctx.prisma.document.findFirst({
        where: { id: input.id, projectId: project.id },
        select: { id: true, status: true, storageKey: true, processedText: true, metadata: true },
      }),
      "Document"
    );
    if (doc.status !== "FAILED") throw new TRPCError({ code: "BAD_REQUEST", message: "Only failed documents can be retried" });
    if (metadataOf(doc.metadata).awaitingUpload === true || (!doc.storageKey && !doc.processedText)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This upload never completed. Delete it and upload the file again." });
    }
    await ctx.prisma.document.update({
      where: { id: doc.id },
      data: { status: "PENDING", errorMessage: null, processingStartedAt: null, processingCompletedAt: null },
    });
    await enqueue(QUEUE.DOCUMENTS, { documentId: doc.id }, { jobId: `doc_${doc.id}_retry_${Date.now()}` });
    return { id: doc.id, status: "PENDING" as const };
  }),

  /** Delete the document, its chunks/vectors/citations (cascade) and its stored file. */
  delete: protectedProcedure.input(z.object({ projectId: id, id })).mutation(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:write");
    const doc = found(
      await ctx.prisma.document.findFirst({ where: { id: input.id, projectId: project.id }, select: { id: true, storageKey: true } }),
      "Document"
    );
    await ctx.prisma.document.delete({ where: { id: doc.id } });
    if (doc.storageKey && keyBelongsToProject(doc.storageKey, project.id)) {
      await getStorage()
        .delete(doc.storageKey)
        .catch((err) => logger.error("failed to delete document object", { documentId: doc.id, err }));
    }
    // Revert the document's contribution to the org knowledge graph (mention
    // counts, relation evidence) so the graph doesn't keep stale counts.
    await removeDocumentKnowledge(doc.id).catch((err) =>
      logger.error("failed to remove document knowledge", { documentId: doc.id, err })
    );
    return { success: true as const };
  }),
});
