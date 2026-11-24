/**
 * Document parsing: turn a stored document into canonical text plus segments
 * (pages, speaker turns, CSV rows) with character offsets into that text.
 *
 * - Dispatches on the stored MIME type, which was derived from the file's bytes
 *   at upload (resolveUploadMime), never on a client-supplied value.
 * - Reads only from the application bucket, only keys inside the document's
 *   project prefix. There is no URL or filesystem branch.
 * - Documents that already carry text (integrations, voice, URL imports, quick
 *   capture) are not re-parsed.
 */
import { ALLOWED_TYPES } from "@/lib/file-types";
import { getStorage, keyBelongsToProject } from "@/lib/storage";
import { NonRetryableError } from "@/server/jobs/worker";
import { MAX_INGEST_CHARS } from "@/server/documents/ingest";
import type { LLMContext } from "../client";
import { csvToRows } from "./csv";
import { parseSubtitles, type SpeakerTurn } from "./subtitles";
import { transcribeMedia } from "./transcribe";

export interface ParsedSegment {
  start: number;
  end: number;
  page?: number;
  speaker?: string;
  startSec?: number;
  row?: number;
}

export interface ParsedDocument {
  text: string;
  segments: ParsedSegment[];
  /** True when the text was cut at MAX_TEXT_CHARS. */
  truncated: boolean;
  originalChars: number;
  /** Extra facts worth storing on the document (page count, duration...). */
  info: Record<string, string | number | boolean>;
}

export const MAX_TEXT_CHARS = MAX_INGEST_CHARS;

/** Remove control characters (keeping tabs and newlines) and normalize line endings. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/­/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

function decodeUtf8(bytes: Buffer): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface Part {
  text: string;
  meta: Omit<ParsedSegment, "start" | "end">;
}

/** Join parts with a separator, recording each part's offsets; caps total length. */
export function joinParts(parts: Part[], separator: string, info: ParsedDocument["info"] = {}): ParsedDocument {
  let text = "";
  const segments: ParsedSegment[] = [];
  let originalChars = 0;
  let truncated = false;
  for (const part of parts) {
    const body = part.text.trim();
    if (!body) continue;
    originalChars += body.length + (originalChars > 0 ? separator.length : 0);
    if (truncated) continue;
    const prefix = text.length > 0 ? separator : "";
    const room = MAX_TEXT_CHARS - text.length - prefix.length;
    if (room <= 0) {
      truncated = true;
      continue;
    }
    const piece = body.length > room ? body.slice(0, room) : body;
    if (piece.length < body.length) truncated = true;
    const start = text.length + prefix.length;
    text += prefix + piece;
    segments.push({ start, end: start + piece.length, ...part.meta });
  }
  return { text, segments, truncated, originalChars, info };
}

const SPEAKER_LINE = /^((?:[A-Z][\w.'-]*)(?: [A-Z][\w.'-]*){0,3}|Speaker \d+|Interviewer|Interviewee|Customer|Agent|Host|Guest|Q|A)\s*(?:\[[\d:.]+\]|\([\d:.]+\))?\s*:\s+\S/;

/**
 * Plain text. Lines that look like "Name: utterance" are treated as speaker turns
 * (so transcripts pasted as text still get speaker metadata).
 */
export function parsePlainText(raw: string): ParsedDocument {
  const text = cleanText(raw).trim();
  const lines = text.split("\n");
  const speakerLines = lines.filter((l) => SPEAKER_LINE.test(l)).length;
  if (speakerLines >= 3 && speakerLines >= lines.filter((l) => l.trim()).length * 0.3) {
    const parts: Part[] = [];
    for (const line of lines) {
      const m = line.match(/^(.+?)\s*(?:\[[\d:.]+\]|\([\d:.]+\))?\s*:\s+(.*)$/);
      if (m && SPEAKER_LINE.test(line)) parts.push({ text: line, meta: { speaker: m[1].trim().slice(0, 60) } });
      else if (parts.length > 0 && line.trim()) parts[parts.length - 1].text += `\n${line}`;
      else if (line.trim()) parts.push({ text: line, meta: {} });
    }
    return joinParts(parts, "\n");
  }
  return joinParts([{ text, meta: {} }], "");
}

export function parseCsvText(raw: string): ParsedDocument {
  const { header, rows, truncated } = csvToRows(cleanText(raw));
  if (rows.length === 0) throw new NonRetryableError("The CSV file has no data rows");
  const doc = joinParts(
    rows.map((r) => ({ text: r.text, meta: { row: r.row } })),
    "\n",
    { rows: rows.length, columns: header.length, rowsTruncated: truncated }
  );
  return doc;
}

export function turnsToDocument(turns: SpeakerTurn[], info: ParsedDocument["info"] = {}): ParsedDocument {
  return joinParts(
    turns.map((t) => ({
      text: t.speaker ? `${t.speaker}: ${t.text}` : t.text,
      meta: {
        ...(t.speaker ? { speaker: t.speaker } : {}),
        ...(t.startSec !== null ? { startSec: t.startSec } : {}),
      },
    })),
    "\n",
    { turns: turns.length, ...info }
  );
}

function flattenJson(value: unknown, path: string, out: string[], depth: number): void {
  if (out.length > 200_000) return;
  if (value === null || value === undefined) return;
  if (typeof value !== "object") {
    const s = String(value).trim();
    if (s) out.push(path ? `${path}: ${s}` : s);
    return;
  }
  if (depth > 12) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenJson(v, path ? `${path}[${i}]` : `[${i}]`, out, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) flattenJson(v, path ? `${path}.${k}` : k, out, depth + 1);
}

/**
 * JSON exports: an array of records becomes one line per record; anything else
 * is flattened to "path: value" lines. Invalid JSON is treated as plain text.
 */
export function parseJsonText(raw: string): ParsedDocument {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return parsePlainText(raw);
  }
  const records = Array.isArray(data) ? data : null;
  if (records && records.length > 0 && records.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
    const parts: Part[] = records.map((r, i) => {
      const lines: string[] = [];
      flattenJson(r, "", lines, 0);
      return { text: lines.join("; "), meta: { row: i + 1 } };
    });
    return joinParts(parts, "\n", { records: records.length });
  }
  const lines: string[] = [];
  flattenJson(data, "", lines, 0);
  return joinParts([{ text: lines.join("\n"), meta: {} }], "");
}

export async function parsePdf(bytes: Buffer): Promise<ParsedDocument> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    const parts: Part[] = result.pages.map((p) => ({ text: cleanText(p.text), meta: { page: p.num } }));
    const doc = joinParts(parts, "\n\n", { pages: result.total });
    if (!doc.text.trim()) {
      throw new NonRetryableError("This PDF has no extractable text (it may be a scanned image)");
    }
    return doc;
  } catch (err) {
    if (err instanceof NonRetryableError) throw err;
    throw new NonRetryableError("This PDF could not be read (it may be encrypted or damaged)");
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/** Parse bytes of a text-family or PDF document by MIME type. */
export async function parseBytes(mimeType: string, bytes: Buffer): Promise<ParsedDocument> {
  switch (mimeType) {
    case "application/pdf":
      return parsePdf(bytes);
    case "text/csv":
      return parseCsvText(decodeUtf8(bytes));
    case "text/vtt":
    case "application/x-subrip": {
      const turns = parseSubtitles(decodeUtf8(bytes));
      if (turns.length === 0) throw new NonRetryableError("The subtitle file has no captions");
      return turnsToDocument(turns);
    }
    case "application/json":
      return parseJsonText(decodeUtf8(bytes));
    case "text/plain":
    case "text/markdown":
      return parsePlainText(decodeUtf8(bytes));
    default:
      throw new NonRetryableError("This file type is not supported");
  }
}

export interface ParseInput {
  projectId: string;
  mimeType: string | null;
  storageKey: string | null;
  processedText: string | null;
  ctx: LLMContext;
}

/** Produce the canonical text for a document (see module doc). */
export async function extractDocument(input: ParseInput): Promise<ParsedDocument> {
  if (input.processedText && input.processedText.trim()) {
    // Already canonical text (integration records, transcripts, URL imports, or a
    // previous successful parse); never re-interpret it as a file format.
    return parsePlainText(input.processedText);
  }
  if (!input.storageKey) throw new NonRetryableError("This document has no content to process");
  if (!keyBelongsToProject(input.storageKey, input.projectId)) {
    throw new NonRetryableError("This document's file is not available");
  }
  const allowed = ALLOWED_TYPES.find((t) => t.mime === input.mimeType);
  if (!allowed) throw new NonRetryableError("This file type is not supported");

  if (allowed.category === "audio" || allowed.category === "video") {
    const { turns, durationSec } = await transcribeMedia({
      storageKey: input.storageKey,
      mimeType: allowed.mime,
      maxBytes: allowed.maxBytes,
      ctx: input.ctx,
    });
    if (turns.length === 0) throw new NonRetryableError("No speech was detected in this recording");
    return turnsToDocument(turns, { durationSec });
  }

  const head = await getStorage().head(input.storageKey);
  if (!head) throw new NonRetryableError("The uploaded file is missing. Please upload it again.");
  if (head.size > allowed.maxBytes) throw new NonRetryableError("The file is larger than the allowed size");
  const bytes = await getStorage().get(input.storageKey, { maxBytes: allowed.maxBytes });
  return parseBytes(allowed.mime, bytes);
}
