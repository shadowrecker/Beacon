/**
 * Deepgram pre-recorded transcription: the single Deepgram client, used by
 * voice recordings and by audio/video document uploads (pipeline/transcribe.ts).
 *
 * Deepgram receives a short-lived presigned GET URL for the recording's
 * server-generated key (never a client-supplied URL). When the storage driver
 * can't produce a publicly reachable https URL (local development), the bytes
 * are streamed in the request body instead. Requests go through safeFetch with a
 * timeout; diarized utterances are kept as speaker turns.
 */
import { NonRetryableError } from "../../jobs/worker";
import { getStorage } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { safeFetch, SafeFetchError, type SafeFetchOptions, type SafeFetchResponse } from "@/lib/safe-fetch";
import { recordTokenUsage } from "@/server/usage/entitlements";
import type { LLMContext } from "../client";

export const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const MAX_INLINE_BYTES = 150 * 1024 * 1024;

/** Deepgram model (DEEPGRAM_MODEL, default nova-3). */
export function deepgramModel(): string {
  return process.env.DEEPGRAM_MODEL || "nova-3";
}

export type DeepgramTransport = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResponse>;
let transport: DeepgramTransport = safeFetch;

/** Test-only: replace the Deepgram transport (null restores safeFetch). */
export function setDeepgramTransportForTests(t: DeepgramTransport | null): void {
  transport = t ?? safeFetch;
}

export interface TranscriptSegment {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  durationSec: number | null;
  speakers: number;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    utterances?: Array<{ start?: number; end?: number; transcript?: string; speaker?: number }>;
  };
}

/** Deepgram response → speaker-labelled transcript text and segments. */
export function parseDeepgram(body: DeepgramResponse): Transcript {
  const segments: TranscriptSegment[] = [];
  for (const u of body.results?.utterances ?? []) {
    const text = (u.transcript ?? "").trim();
    if (!text) continue;
    const speaker = Number.isInteger(u.speaker) ? (u.speaker as number) : 0;
    const prev = segments[segments.length - 1];
    // Merge consecutive utterances by the same speaker into one turn.
    if (prev && prev.speaker === speaker && (u.start ?? 0) - prev.end < 2) {
      prev.text = `${prev.text} ${text}`;
      prev.end = u.end ?? prev.end;
    } else {
      segments.push({ speaker, start: u.start ?? 0, end: u.end ?? u.start ?? 0, text });
    }
  }
  const speakers = new Set(segments.map((s) => s.speaker)).size;
  let text: string;
  if (segments.length > 0) {
    text = segments.map((s) => (speakers > 1 ? `Speaker ${s.speaker + 1}: ${s.text}` : s.text)).join("\n\n");
  } else {
    text = (body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
  }
  const duration = Number(body.metadata?.duration);
  return { text, segments, durationSec: Number.isFinite(duration) ? Math.round(duration) : null, speakers };
}

function deepgramError(status: number): Error {
  if (status === 401 || status === 403) return new NonRetryableError("Transcription failed: the Deepgram API key was rejected");
  if (status === 402) return new NonRetryableError("Transcription failed: the Deepgram account is out of credit");
  if (status === 400 || status === 415 || status === 413) return new NonRetryableError("Transcription failed: the audio couldn't be processed");
  const err = new Error(`Transcription failed (Deepgram status ${status})`) as Error & { status: number };
  err.status = status;
  return err;
}

export interface TranscribeOptions {
  /** Cap for sending bytes inline when storage isn't reachable by Deepgram. */
  maxInlineBytes?: number;
  /** When set, audio seconds are recorded as usage for cost reporting. */
  usage?: LLMContext;
}

export async function transcribeObject(audioKey: string, mimeType: string | null, options: TranscribeOptions = {}): Promise<Transcript> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new NonRetryableError("Transcription is not configured (DEEPGRAM_API_KEY)");

  const model = deepgramModel();
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
  });
  const url = `${DEEPGRAM_URL}?${params.toString()}`;
  const storage = getStorage();
  const presigned = await storage.presignGet(audioKey, { expiresInSec: 3600 });

  let opts: SafeFetchOptions;
  if (presigned.startsWith("https://")) {
    opts = { method: "POST", headers: { authorization: `Token ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ url: presigned }) };
  } else {
    // Storage isn't reachable from Deepgram (local dev): send the audio itself.
    const bytes = await storage.get(audioKey, { maxBytes: options.maxInlineBytes ?? MAX_INLINE_BYTES });
    opts = { method: "POST", headers: { authorization: `Token ${apiKey}`, "content-type": mimeType ?? "application/octet-stream" }, body: new Uint8Array(bytes) };
  }

  let res: SafeFetchResponse;
  try {
    // Deepgram replies only once transcription is done: allow long header waits.
    res = await transport(url, { ...opts, timeoutMs: 10 * 60_000, headersTimeoutMs: 10 * 60_000, bodyTimeoutMs: 120_000, maxBytes: 20 * 1024 * 1024, maxRedirects: 0 });
  } catch (err) {
    if (err instanceof SafeFetchError && (err.code === "TIMEOUT" || err.code === "NETWORK")) {
      const e = new Error("Transcription request to Deepgram failed; retrying") as Error & { status: number };
      e.status = 503;
      throw e;
    }
    throw err;
  }
  if (!res.ok) throw deepgramError(res.status);
  let transcript: Transcript;
  try {
    transcript = parseDeepgram(res.json<DeepgramResponse>());
  } catch {
    throw new NonRetryableError("Transcription failed: unexpected response from Deepgram");
  }
  if (options.usage && transcript.durationSec && transcript.durationSec > 0) {
    // Deepgram bills per audio second; usage rows record seconds as input units
    // (excluded from the LLM token budget, see entitlements).
    await recordTokenUsage({
      orgId: options.usage.orgId,
      projectId: options.usage.projectId ?? null,
      feature: options.usage.feature,
      provider: "deepgram",
      model,
      inputTokens: transcript.durationSec,
      outputTokens: 0,
    }).catch((err) => logger.error("failed to record transcription usage", { err }));
  }
  return transcript;
}
