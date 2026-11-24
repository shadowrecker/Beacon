/**
 * Chunking: split canonical document text into overlapping, sentence-aligned
 * chunks for embedding and retrieval.
 *
 * - Token counts use a conservative estimate (max of chars/4 and words×1.3).
 * - Sentences (and transcript turns) longer than the target are split on word
 *   boundaries, and pathological "words" (minified data, base64) on character
 *   windows, so no chunk can exceed MAX_CHUNK_TOKENS.
 * - Every chunk's content is exactly text.slice(startOffset, endOffset), so
 *   offsets are real and quotes can be verified against chunk content.
 * - Page, speaker, timestamp and row metadata come from parser segments.
 */
import type { ChunkData, ChunkMetadata } from "../types";
import type { ParsedSegment } from "./parser";

export interface ChunkOptions {
  /** Target tokens per chunk (packing stops before exceeding this). */
  targetTokens?: number;
  /** Tokens of trailing context repeated at the start of the next chunk. */
  overlapTokens?: number;
}

/** Hard ceiling; well under the embedding model's 8k-token input limit. */
export const MAX_CHUNK_TOKENS = 1000;
const DEFAULT_TARGET = 400;
const DEFAULT_OVERLAP = 50;

interface Unit {
  start: number;
  end: number;
  words: number;
  meta: Omit<ParsedSegment, "start" | "end">;
}

function tokensFor(chars: number, words: number): number {
  return Math.max(Math.ceil(chars / 4), Math.ceil(words * 1.3));
}

function countWords(text: string, start: number, end: number): number {
  let n = 0;
  let inWord = false;
  for (let i = start; i < end; i++) {
    const ws = text.charCodeAt(i) <= 32;
    if (!ws && !inWord) n++;
    inWord = !ws;
  }
  return n;
}

/** Trim whitespace from a [start, end) range; returns null when empty. */
function trimRange(text: string, start: number, end: number): [number, number] | null {
  let s = start;
  let e = end;
  while (s < e && text.charCodeAt(s) <= 32) s++;
  while (e > s && text.charCodeAt(e - 1) <= 32) e--;
  return e > s ? [s, e] : null;
}

/** Sentence boundaries: after .!? followed by whitespace, and at every line break. */
function sentenceRanges(text: string, start: number, end: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = start;
  for (let i = start; i < end; i++) {
    const ch = text[i];
    const isTerminal = (ch === "." || ch === "!" || ch === "?") && (i + 1 >= end || text.charCodeAt(i + 1) <= 32);
    if (isTerminal || ch === "\n") {
      const r = trimRange(text, s, i + 1);
      if (r) out.push(r);
      s = i + 1;
    }
  }
  const r = trimRange(text, s, end);
  if (r) out.push(r);
  return out;
}

/** Split a range that is too large into word-aligned (or char-window) pieces. */
function splitOversized(text: string, start: number, end: number, maxTokens: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  const maxChars = maxTokens * 4;
  const wordRe = /\S+/g;
  wordRe.lastIndex = start;
  let pieceStart = -1;
  let pieceEnd = -1;
  let words = 0;
  for (let m = wordRe.exec(text); m && m.index < end; m = wordRe.exec(text)) {
    let ws = m.index;
    const we = Math.min(m.index + m[0].length, end);
    // A single over-long token: emit character windows.
    while (we - ws > maxChars) {
      if (pieceStart >= 0) {
        pieces.push([pieceStart, pieceEnd]);
        pieceStart = -1;
        words = 0;
      }
      pieces.push([ws, ws + maxChars]);
      ws += maxChars;
    }
    if (pieceStart < 0) {
      pieceStart = ws;
      pieceEnd = we;
      words = 1;
      continue;
    }
    if (tokensFor(we - pieceStart, words + 1) > maxTokens) {
      pieces.push([pieceStart, pieceEnd]);
      pieceStart = ws;
      words = 1;
    } else {
      words++;
    }
    pieceEnd = we;
  }
  if (pieceStart >= 0) pieces.push([pieceStart, pieceEnd]);
  return pieces;
}

function buildUnits(text: string, segments: ParsedSegment[], targetTokens: number): Unit[] {
  const regions: ParsedSegment[] = segments.length > 0 ? segments : [{ start: 0, end: text.length }];
  const units: Unit[] = [];
  for (const seg of regions) {
    const meta: Unit["meta"] = { page: seg.page, speaker: seg.speaker, startSec: seg.startSec, row: seg.row };
    for (const [s, e] of sentenceRanges(text, seg.start, seg.end)) {
      const words = countWords(text, s, e);
      if (tokensFor(e - s, words) <= targetTokens) {
        units.push({ start: s, end: e, words, meta });
      } else {
        for (const [ps, pe] of splitOversized(text, s, e, targetTokens)) {
          units.push({ start: ps, end: pe, words: countWords(text, ps, pe), meta });
        }
      }
    }
  }
  return units;
}

function metadataFor(units: Unit[]): ChunkMetadata {
  const meta: ChunkMetadata = {};
  const pages = units.map((u) => u.meta.page).filter((p): p is number => typeof p === "number");
  if (pages.length > 0) meta.pages = [Math.min(...pages), Math.max(...pages)];
  const rows = units.map((u) => u.meta.row).filter((r): r is number => typeof r === "number");
  if (rows.length > 0) meta.rows = [Math.min(...rows), Math.max(...rows)];
  const speakers: string[] = [];
  for (const u of units) {
    if (u.meta.speaker && !speakers.includes(u.meta.speaker) && speakers.length < 10) speakers.push(u.meta.speaker);
  }
  if (speakers.length > 0) meta.speakers = speakers;
  const firstTimed = units.find((u) => typeof u.meta.startSec === "number");
  if (firstTimed) meta.startSec = firstTimed.meta.startSec;
  return meta;
}

/** Chunk `text` (see module doc). Returns chunks in document order. */
export function chunkText(text: string, segments: ParsedSegment[] = [], opts: ChunkOptions = {}): ChunkData[] {
  const target = Math.min(opts.targetTokens ?? DEFAULT_TARGET, MAX_CHUNK_TOKENS);
  const overlap = Math.max(0, Math.min(opts.overlapTokens ?? DEFAULT_OVERLAP, Math.floor(target / 4)));
  const units = buildUnits(text, segments, target);
  const chunks: ChunkData[] = [];

  let current: Unit[] = [];
  let words = 0;

  const emit = () => {
    if (current.length === 0) return;
    const startOffset = current[0].start;
    const endOffset = current[current.length - 1].end;
    chunks.push({
      content: text.slice(startOffset, endOffset),
      position: chunks.length,
      startOffset,
      endOffset,
      tokenCount: tokensFor(endOffset - startOffset, words),
      metadata: metadataFor(current),
    });
  };

  for (const unit of units) {
    if (current.length > 0) {
      const projected = tokensFor(unit.end - current[0].start, words + unit.words);
      if (projected > target) {
        emit();
        // Carry trailing units (up to `overlap` tokens) into the next chunk.
        const carried: Unit[] = [];
        let carriedWords = 0;
        for (let i = current.length - 1; i >= 1; i--) {
          const u = current[i];
          if (tokensFor(unit.end - u.start, carriedWords + u.words + unit.words) > target) break;
          if (tokensFor(current[current.length - 1].end - u.start, carriedWords + u.words) > overlap) break;
          carried.unshift(u);
          carriedWords += u.words;
        }
        current = carried;
        words = carriedWords;
      }
    }
    current.push(unit);
    words += unit.words;
  }
  emit();
  return chunks;
}
