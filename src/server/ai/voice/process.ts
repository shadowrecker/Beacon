/**
 * Voice recording processing (QUEUE.VOICE):
 * TRANSCRIBING → Deepgram (diarized) → transcript + speaker turns stored →
 * Document created from the transcript (so voice flows into synthesis, RAG,
 * knowledge and sentiment) → ANALYZING → VoiceInsight → READY, voice.ready.
 *
 * Idempotent: a stored transcript is never re-requested, the document is found
 * by its recordingId before one is created, and the insight is upserted.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { keyBelongsToProject } from "@/lib/storage";
import { createDocumentFromText } from "../../documents/ingest";
import { emitEvent } from "../../events/bus";
import { failureMessage, isNonRetryable, NonRetryableError } from "../../jobs/worker";
import { analyzeTranscript } from "./analyzer";
import { transcribeObject, type TranscriptSegment } from "./transcriber";

const MAX_SEGMENTS = 5_000;

export function recordingTitle(r: { title: string | null; recordedAt: Date }): string {
  return r.title?.trim() || `Voice recording ${r.recordedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

async function findOrCreateDocument(rec: {
  id: string;
  projectId: string;
  userId: string;
  documentId: string | null;
  title: string;
  transcript: string;
  durationSec: number;
}): Promise<string> {
  if (rec.documentId) return rec.documentId;
  const existing = await prisma.document.findFirst({
    where: { projectId: rec.projectId, source: "VOICE", metadata: { path: ["recordingId"], equals: rec.id } },
    select: { id: true },
  });
  const documentId =
    existing?.id ??
    (
      await createDocumentFromText({
        projectId: rec.projectId,
        title: rec.title,
        type: "CALL_RECORDING",
        source: "VOICE",
        text: rec.transcript,
        createdById: rec.userId,
        metadata: { recordingId: rec.id, durationSec: rec.durationSec },
      })
    ).documentId;
  await prisma.voiceRecording.update({ where: { id: rec.id }, data: { documentId } });
  return documentId;
}

export async function runVoiceProcessing(data: { recordingId: string }, log: Logger): Promise<{ status: string; documentId: string | null }> {
  const rec = await prisma.voiceRecording.findUnique({ where: { id: data.recordingId } });
  if (!rec) throw new NonRetryableError("Recording not found");
  if (rec.status === "READY" && rec.documentId) return { status: "skipped", documentId: rec.documentId };
  if (!rec.projectId) throw new NonRetryableError("This recording isn't attached to a project");
  const project = await prisma.project.findUnique({ where: { id: rec.projectId }, select: { id: true, orgId: true } });
  if (!project) throw new NonRetryableError("The recording's project no longer exists");
  if (!keyBelongsToProject(rec.audioKey, project.id)) throw new NonRetryableError("Recording storage key is invalid");

  // 1. Transcribe (once).
  let transcript = rec.transcriptText;
  let duration = rec.duration;
  if (!transcript) {
    await prisma.voiceRecording.update({ where: { id: rec.id }, data: { status: "TRANSCRIBING", errorMessage: null } });
    const t = await transcribeObject(rec.audioKey, rec.mimeType, { usage: { feature: "voice.transcribe", orgId: project.orgId, projectId: project.id } });
    if (!t.text.trim()) throw new NonRetryableError("No speech was detected in this recording");
    transcript = t.text;
    duration = t.durationSec ?? rec.duration;
    const segments: TranscriptSegment[] = t.segments.slice(0, MAX_SEGMENTS);
    await prisma.voiceRecording.update({
      where: { id: rec.id },
      data: {
        transcriptText: transcript,
        transcriptSegments: segments as unknown as Prisma.InputJsonValue,
        duration,
        status: "ANALYZING",
      },
    });
  }

  // 2. Document (the transcript is the durable value; created before analysis).
  const title = recordingTitle(rec);
  const documentId = await findOrCreateDocument({
    id: rec.id,
    projectId: project.id,
    userId: rec.userId,
    documentId: rec.documentId,
    title,
    transcript,
    durationSec: duration,
  });

  // 3. Insights.
  let errorMessage: string | null = null;
  try {
    await prisma.voiceRecording.update({ where: { id: rec.id }, data: { status: "ANALYZING" } });
    const { analysis, analyzedChars, totalChars } = await analyzeTranscript({ orgId: project.orgId, projectId: project.id, title }, transcript);
    const fields = {
      summary: analysis.summary,
      keyPoints: analysis.keyPoints,
      painPoints: analysis.painPoints,
      actionItems: analysis.actionItems,
      questions: analysis.questions,
      sentimentScore: analysis.sentimentScore,
      themes: analysis.themes,
      suggestedFollowUps: analysis.suggestedFollowUps,
      claudeAnalysis: { ...analysis, analyzedChars, totalChars, truncated: analyzedChars < totalChars } as Prisma.InputJsonValue,
    };
    await prisma.voiceInsight.upsert({ where: { recordingId: rec.id }, create: { recordingId: rec.id, ...fields }, update: fields });
  } catch (err) {
    // A permanent analysis failure (budget, refusal) still leaves a usable transcript.
    if (!isNonRetryable(err)) throw err;
    errorMessage = `Transcript ready; insights couldn't be generated: ${failureMessage(err)}`;
    log.warn("voice insight generation failed", { recordingId: rec.id, err });
  }

  await prisma.voiceRecording.update({
    where: { id: rec.id },
    data: { status: "READY", processedAt: new Date(), errorMessage },
  });
  await emitEvent({
    orgId: project.orgId,
    projectId: project.id,
    type: "voice.ready",
    payload: { recordingId: rec.id, documentId },
    actorUserId: rec.userId,
  });
  return { status: "ready", documentId };
}

/** onFinalFailure: FAILED with a message, unless a transcript document already exists. */
export async function markVoiceFailed(data: { recordingId: string }, err: Error): Promise<void> {
  const rec = await prisma.voiceRecording.findUnique({ where: { id: data.recordingId }, select: { id: true, status: true, documentId: true } });
  if (!rec || rec.status === "READY") return;
  const message = failureMessage(err);
  await prisma.voiceRecording.update({
    where: { id: rec.id },
    data: rec.documentId
      ? { status: "READY", processedAt: new Date(), errorMessage: `Transcript ready; insights couldn't be generated: ${message}` }
      : { status: "FAILED", errorMessage: message },
  });
}
