/**
 * Small helpers shared by the data-spine AI modules (pipeline, RAG, synthesis,
 * recommendations, briefs).
 */

/**
 * Conservative token estimate for English prose: the larger of ~4 characters
 * per token and ~1.3 tokens per word. Over-estimating keeps chunks safely under
 * the embedding model's input limit.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(Math.ceil(text.length / 4), Math.ceil(words * 1.3));
}

export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Truncate to `max` characters on a word boundary when possible (with an ellipsis). */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Split items into consecutive batches bounded by count and by a size measure
 * (e.g. characters). A single item larger than `maxSize` gets its own batch.
 */
export function batchBySize<T>(items: T[], maxCount: number, maxSize: number, sizeOf: (item: T) => number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const s = sizeOf(item);
    if (current.length > 0 && (current.length >= maxCount || size + s > maxSize)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += s;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ---------------------------------------------------------------------------
// Quote verification
// ---------------------------------------------------------------------------

const CHAR_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
};

/** Normalize text for tolerant matching, keeping a map back to original indices. */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let lastWasSpace = true; // trims leading whitespace
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        norm += " ";
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    const mapped = (CHAR_MAP[ch] ?? ch).toLowerCase();
    for (const m of mapped) {
      norm += m;
      map.push(i);
    }
    lastWasSpace = false;
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

export const MIN_QUOTE_CHARS = 8;
export const MAX_QUOTE_CHARS = 600;

/**
 * Find `quote` inside `content`. Exact matches are preferred; otherwise matching
 * tolerates whitespace, case and typographic-quote differences. Returns the
 * verbatim substring of `content` (so stored quotes are always real source
 * text), or null when the quote is not in the content.
 */
export function locateQuote(content: string, quote: string): { text: string; start: number; end: number } | null {
  const q = quote.trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (q.length < MIN_QUOTE_CHARS || q.length > MAX_QUOTE_CHARS * 2) return null;

  const exact = content.indexOf(q);
  if (exact >= 0) return { text: q.slice(0, MAX_QUOTE_CHARS), start: exact, end: exact + Math.min(q.length, MAX_QUOTE_CHARS) };

  const c = normalizeWithMap(content);
  const n = normalizeWithMap(q).norm;
  if (n.length < MIN_QUOTE_CHARS) return null;
  const at = c.norm.indexOf(n);
  if (at < 0) return null;
  const start = c.map[at];
  const end = c.map[at + n.length - 1] + 1;
  const text = content.slice(start, end);
  return { text: text.slice(0, MAX_QUOTE_CHARS), start, end: start + Math.min(text.length, MAX_QUOTE_CHARS) };
}
