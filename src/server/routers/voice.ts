/**
 * Voice recordings and quick capture.
 *
 * Recordings always belong to a project the caller can write to. The client
 * never supplies a storage location: createRecording generates the object key
 * server-side and returns a presigned POST; finalizeRecording checks the
 * uploaded bytes (magic numbers) before queueing transcription. Downloads use
 * short-lived presigned GETs.
 */
import { randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { allowedTypeForFilename, resolveUploadMime } from "@/lib/file-types";
import { logger } from "@/lib/logger";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { getStorage, keyBelongsToProject, projectObjectKey } from "@/lib/storage";
import { can, requireProjectAccess } from "../auth/access";
import { createDocumentFromText } from "../documents/ingest";
import { enqueue, QUEUE } from "../jobs/queues";
import { llmProcedure, orgProcedure, protectedProcedure, rateLimited, router } from "../trpc";
import { recordingTitle } from "../ai/voice/process";

const id = z.string().min(1).max(64);

/** Recorder MIME (codec parameters stripped) → stored extension. */
export const RECORDING_TYPES: Record<string, { ext: string; mime: string }> = {
  "audio/webm": { ext: "weba", mime: "audio/webm" },
  "video/webm": { ext: "weba", mime: "audio/webm" },
  "audio/mp4": { ext: "m4a", mime: "audio/mp4" },
  "audio/x-m4a": { ext: "m4a", mime: "audio/mp4" },
  "audio/aac": { ext: "m4a", mime: "audio/mp4" },
  "audio/ogg": { ext: "ogg", mime: "audio/ogg" },
  "audio/mpeg": { ext: "mp3", mime: "audio/mpeg" },
  "audio/wav": { ext: "wav", mime: "audio/wav" },
  "audio/x-wav": { ext: "wav", mime: "audio/wav" },
};

const MAX_RECORDING_BYTES = 300 * 1024 * 1024;

export function recordingType(mimeType: string): { ext: string; mime: string } | null {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  return RECORDING_TYPES[base] ?? null;
}

function newId(): string {
  return `c${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

const deviceInfo = z
  .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((d) => Object.keys(d).length <= 12, "Too many device fields")
  .optional();

async function readableRecording(ctx: Parameters<typeof requireProjectAccess>[0], recordingId: string) {
  const rec = await ctx.prisma.voiceRecording.findUnique({ where: { id: recordingId }, select: { id: true, projectId: true, userId: true } });
  if (!rec || !rec.projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
  const project = await requireProjectAccess(ctx, rec.projectId, "project:read");
  return { ...rec, projectId: rec.projectId, project };
}

const listSelect = {
  id: true,
  title: true,
  duration: true,
  status: true,
  errorMessage: true,
  recordedAt: true,
  createdAt: true,
  projectId: true,
  userId: true,
  documentId: true,
  project: { select: { id: true, name: true } },
  insight: { select: { summary: true, sentimentScore: true, themes: true } },
} as const;

export const voiceRouter = router({
  createRecording: protectedProcedure
    .use(rateLimited(RATE_LIMITS.upload))
    .input(
      z.object({
        projectId: id,
        mimeType: z.string().trim().min(1).max(100),
        durationSec: z.number().int().min(1, "Recordings must be at least a second long").max(4 * 3600),
        title: z.string().trim().max(200).optional(),
        recordedAt: z.coerce.date().optional(),
        deviceInfo,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      const type = recordingType(input.mimeType);
      if (!type) throw new TRPCError({ code: "BAD_REQUEST", message: "This audio format isn't supported" });
      const recordingId = newId();
      const filename = `recording.${type.ext}`;
      const allowed = allowedTypeForFilename(filename);
      if (!allowed) throw new TRPCError({ code: "BAD_REQUEST", message: "This audio format isn't supported" });
      const audioKey = projectObjectKey(project.id, "voice", recordingId, filename);
      const recordedAt = input.recordedAt && input.recordedAt.getTime() <= Date.now() + 60_000 ? input.recordedAt : new Date();

      await ctx.prisma.voiceRecording.create({
        data: {
          id: recordingId,
          projectId: project.id,
          userId: ctx.user.id,
          title: input.title || null,
          duration: input.durationSec,
          audioKey,
          mimeType: allowed.mime,
          status: "UPLOADING",
          recordedAt,
          deviceInfo: input.deviceInfo ?? undefined,
        },
      });
      const upload = await getStorage().createUpload({
        key: audioKey,
        contentType: allowed.mime,
        maxBytes: Math.min(allowed.maxBytes, MAX_RECORDING_BYTES),
      });
      return { recordingId, upload: { url: upload.url, fields: upload.fields, expiresAt: upload.expiresAt, contentType: allowed.mime } };
    }),

  finalizeRecording: llmProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const rec = await ctx.prisma.voiceRecording.findUnique({
      where: { id: input.id },
      select: { id: true, projectId: true, userId: true, audioKey: true, status: true },
    });
    if (!rec || !rec.projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
    await requireProjectAccess(ctx, rec.projectId, "project:write");
    if (rec.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who recorded this can finalize it" });
    if (rec.status !== "UPLOADING" && rec.status !== "RECORDING") return { id: rec.id, status: rec.status };
    if (!keyBelongsToProject(rec.audioKey, rec.projectId)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid recording" });

    const storage = getStorage();
    const head = await storage.head(rec.audioKey);
    if (!head || head.size === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "The upload didn't finish. Try uploading again." });
    const firstBytes = await storage.get(rec.audioKey, { range: [0, 4095] });
    const filename = rec.audioKey.split("/").pop() ?? "recording";
    const check = resolveUploadMime(filename, firstBytes);
    if (!check.ok) {
      await storage.delete(rec.audioKey).catch((err) => logger.warn("failed to delete rejected upload", { err }));
      await ctx.prisma.voiceRecording.update({ where: { id: rec.id }, data: { status: "FAILED", errorMessage: check.reason } });
      throw new TRPCError({ code: "BAD_REQUEST", message: check.reason });
    }
    await ctx.prisma.voiceRecording.update({ where: { id: rec.id }, data: { status: "TRANSCRIBING", errorMessage: null } });
    await enqueue(QUEUE.VOICE, { recordingId: rec.id }, { jobId: `voice_${rec.id}` });
    return { id: rec.id, status: "TRANSCRIBING" as const };
  }),

  list: orgProcedure
    .input(
      z
        .object({
          projectId: id.optional(),
          mine: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(20),
          cursor: id.optional(),
        })
        .default({ mine: false, limit: 20 })
    )
    .query(async ({ ctx, input }) => {
      if (input.projectId) {
        const project = await requireProjectAccess(ctx, input.projectId, "project:read");
        if (project.orgId !== ctx.org.orgId) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }
      const rows = await ctx.prisma.voiceRecording.findMany({
        where: {
          project: { orgId: ctx.org.orgId },
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.mine ? { userId: ctx.user.id } : {}),
        },
        orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: listSelect,
      });
      const items = rows.slice(0, input.limit).map(({ userId, insight, ...r }) => ({
        ...r,
        isMine: userId === ctx.user.id,
        insight: insight ? { summary: insight.summary.slice(0, 300), sentimentScore: insight.sentimentScore, themes: insight.themes } : null,
      }));
      return { items, nextCursor: rows.length > input.limit ? items[items.length - 1].id : null };
    }),

  get: protectedProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const { project } = await readableRecording(ctx, input.id);
    const rec = await ctx.prisma.voiceRecording.findUniqueOrThrow({
      where: { id: input.id },
      select: {
        id: true,
        title: true,
        duration: true,
        status: true,
        errorMessage: true,
        recordedAt: true,
        processedAt: true,
        createdAt: true,
        mimeType: true,
        userId: true,
        transcriptText: true,
        transcriptSegments: true,
        documentId: true,
        project: { select: { id: true, name: true } },
        insight: true,
      },
    });
    const segments = Array.isArray(rec.transcriptSegments) ? (rec.transcriptSegments as Array<{ speaker: number; start: number; end: number; text: string }>).slice(0, 2_000) : [];
    const { userId, transcriptSegments: _s, ...rest } = rec;
    return {
      ...rest,
      segments,
      isMine: userId === ctx.user.id,
      canDelete: userId === ctx.user.id ? can(project.role, "project:write") : can(project.role, "project:delete"),
    };
  }),

  /** Short-lived download/playback URL for the recording's audio. */
  getAudioUrl: protectedProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const { projectId } = await readableRecording(ctx, input.id);
    const rec = await ctx.prisma.voiceRecording.findUniqueOrThrow({ where: { id: input.id }, select: { audioKey: true, title: true, recordedAt: true, status: true } });
    if (rec.status === "UPLOADING" || rec.status === "RECORDING") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The upload hasn't finished" });
    if (!keyBelongsToProject(rec.audioKey, projectId)) throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
    const ext = rec.audioKey.split(".").pop() ?? "audio";
    const name = `${recordingTitle(rec).replace(/[^\w .-]+/g, "").slice(0, 80) || "recording"}.${ext}`;
    const expiresInSec = 300;
    const url = await getStorage().presignGet(rec.audioKey, { expiresInSec, downloadName: name });
    return { url, filename: name, expiresAt: new Date(Date.now() + expiresInSec * 1000) };
  }),

  getInsights: protectedProcedure
    .input(z.object({ projectId: id, limit: z.number().int().min(1).max(50).default(10), cursor: id.optional() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.voiceInsight.findMany({
        where: { recording: { projectId: project.id } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          summary: true,
          keyPoints: true,
          painPoints: true,
          actionItems: true,
          questions: true,
          sentimentScore: true,
          themes: true,
          suggestedFollowUps: true,
          createdAt: true,
          recording: { select: { id: true, title: true, recordedAt: true, duration: true } },
        },
      });
      const items = rows.slice(0, input.limit);
      return { items, nextCursor: rows.length > input.limit ? items[items.length - 1].id : null };
    }),

  deleteRecording: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const rec = await ctx.prisma.voiceRecording.findUnique({
      where: { id: input.id },
      select: { id: true, projectId: true, userId: true, audioKey: true, documentId: true },
    });
    if (!rec || !rec.projectId) throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
    const project = await requireProjectAccess(ctx, rec.projectId, "project:read");
    const allowed = rec.userId === ctx.user.id ? can(project.role, "project:write") : can(project.role, "project:delete");
    if (!allowed) throw new TRPCError({ code: "FORBIDDEN", message: "You can't delete this recording" });

    // The audio is customer PII: remove the object first, so a failure leaves nothing orphaned.
    if (keyBelongsToProject(rec.audioKey, rec.projectId)) await getStorage().delete(rec.audioKey);
    await prisma.$transaction([
      prisma.quickCapture.updateMany({ where: { recordingId: rec.id }, data: { recordingId: null } }),
      prisma.voiceRecording.delete({ where: { id: rec.id } }),
      ...(rec.documentId ? [prisma.document.deleteMany({ where: { id: rec.documentId, projectId: rec.projectId } })] : []),
    ]);
    return { id: rec.id };
  }),

  quickCapture: protectedProcedure
    .use(rateLimited(RATE_LIMITS.write))
    .input(
      z.object({
        projectId: id.optional(),
        type: z.enum(["QUICK_THOUGHT", "VOICE_NOTE", "CALL_HIGHLIGHT"]),
        content: z.string().trim().min(1, "Write something first").max(20_000),
        recordingId: id.optional(),
        durationSec: z.number().int().min(0).max(4 * 3600).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      let projectId: string | null = null;
      if (input.projectId) projectId = (await requireProjectAccess(ctx, input.projectId, "project:write")).id;
      if (input.recordingId) {
        const rec = await ctx.prisma.voiceRecording.findFirst({ where: { id: input.recordingId, userId: ctx.user.id }, select: { projectId: true } });
        if (!rec || (projectId && rec.projectId !== projectId)) throw new TRPCError({ code: "NOT_FOUND", message: "Recording not found" });
      }
      const capture = await ctx.prisma.quickCapture.create({
        data: {
          userId: ctx.user.id,
          projectId,
          type: input.type,
          content: input.content,
          recordingId: input.recordingId ?? null,
          durationSec: input.durationSec ?? null,
          syncedToProject: false,
        },
        select: { id: true, createdAt: true },
      });
      let documentId: string | null = null;
      if (projectId) {
        documentId = (await createCaptureDocument(ctx.user.id, projectId, input.type, input.content)).documentId;
        await ctx.prisma.quickCapture.update({ where: { id: capture.id }, data: { syncedToProject: true } });
      }
      return { id: capture.id, createdAt: capture.createdAt, documentId };
    }),

  listQuickCaptures: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(20), cursor: id.optional() }).default({ limit: 20 }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.prisma.quickCapture.findMany({
        where: { userId: ctx.user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, type: true, content: true, syncedToProject: true, createdAt: true, project: { select: { id: true, name: true } } },
      });
      const items = rows.slice(0, input.limit).map((r) => ({ ...r, content: r.content.slice(0, 1_000) }));
      return { items, nextCursor: rows.length > input.limit ? items[items.length - 1].id : null };
    }),

  /** File a capture (made without a project, or not yet synced) into a project as a document. */
  syncToProject: protectedProcedure
    .input(z.object({ captureId: id, projectId: id }))
    .mutation(async ({ ctx, input }) => {
      const capture = await ctx.prisma.quickCapture.findFirst({
        where: { id: input.captureId, userId: ctx.user.id },
        select: { id: true, type: true, content: true, syncedToProject: true, projectId: true },
      });
      if (!capture) throw new TRPCError({ code: "NOT_FOUND", message: "Capture not found" });
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      if (capture.syncedToProject) {
        throw new TRPCError({ code: "CONFLICT", message: "This capture is already in a project" });
      }
      const { documentId } = await createCaptureDocument(ctx.user.id, project.id, capture.type, capture.content);
      await ctx.prisma.quickCapture.update({ where: { id: capture.id }, data: { projectId: project.id, syncedToProject: true } });
      return { id: capture.id, projectId: project.id, documentId };
    }),
});

function createCaptureDocument(userId: string, projectId: string, type: string, content: string) {
  const firstLine = content.split("\n").map((l) => l.trim()).find(Boolean) ?? "Quick capture";
  const label = type === "CALL_HIGHLIGHT" ? "Call highlight" : type === "VOICE_NOTE" ? "Voice note" : "Quick thought";
  return createDocumentFromText({
    projectId,
    title: `${label}: ${firstLine.slice(0, 120)}`,
    type: "NOTE",
    source: "QUICK_CAPTURE",
    text: content,
    createdById: userId,
    metadata: { captureType: type },
  });
}
