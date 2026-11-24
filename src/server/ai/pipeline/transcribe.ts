/**
 * Audio/video document transcription: an adapter over the single Deepgram
 * client (src/server/ai/voice/transcriber.ts), converting diarized segments to
 * the pipeline's speaker turns.
 */
import type { LLMContext } from "../client";
import { deepgramModel, transcribeObject } from "../voice/transcriber";
import type { SpeakerTurn } from "./subtitles";

export function transcriptionModel(): string {
  return deepgramModel();
}

interface DeepgramUtterance {
  start: number;
  end: number;
  transcript: string;
  speaker?: number;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    utterances?: DeepgramUtterance[];
    channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
  };
}

/** Merge consecutive utterances from the same speaker into turns (pure; used in tests). */
export function deepgramTurns(res: DeepgramResponse): SpeakerTurn[] {
  const utterances = res.results?.utterances ?? [];
  if (utterances.length === 0) {
    const transcript = res.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
    return transcript ? [{ speaker: null, startSec: 0, text: transcript }] : [];
  }
  const turns: SpeakerTurn[] = [];
  for (const u of utterances) {
    const text = u.transcript.trim();
    if (!text) continue;
    const speaker = typeof u.speaker === "number" ? `Speaker ${u.speaker + 1}` : null;
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === speaker) prev.text = `${prev.text} ${text}`;
    else turns.push({ speaker, startSec: Math.max(0, Math.round(u.start)), text });
  }
  return turns;
}

export interface TranscribeInput {
  storageKey: string;
  mimeType: string;
  maxBytes: number;
  ctx: LLMContext;
}

export async function transcribeMedia(input: TranscribeInput): Promise<{ turns: SpeakerTurn[]; durationSec: number }> {
  const t = await transcribeObject(input.storageKey, input.mimeType, { maxInlineBytes: input.maxBytes, usage: input.ctx });
  const turns: SpeakerTurn[] =
    t.segments.length > 0
      ? t.segments.map((seg) => ({ speaker: `Speaker ${seg.speaker + 1}`, startSec: Math.max(0, Math.round(seg.start)), text: seg.text }))
      : t.text
        ? [{ speaker: null, startSec: 0, text: t.text }]
        : [];
  return { turns, durationSec: Math.max(0, t.durationSec ?? 0) };
}
