/**
 * Pure text helpers for the knowledge graph: entity-name normalization (the
 * dedupe key in `@@unique([orgId, normalizedName, type])`) and evidence-quote
 * verification (a quote is kept only if it really occurs in the cited chunk).
 */

export const MAX_ENTITY_NAME = 200;
export const MAX_QUOTE_CHARS = 500;
export const MIN_QUOTE_CHARS = 8;

/** Lowercase, NFKC, collapse whitespace, strip wrapping quotes/punctuation. */
export function normalizeEntityName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:!?()[\]{}-]+|[\s.,;:!?()[\]{}-]+$/g, "")
    .trim()
    .slice(0, MAX_ENTITY_NAME);
}

/** Clean a display name: trim, collapse whitespace, cap length. */
export function cleanDisplayName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, MAX_ENTITY_NAME);
}

/** Canonical form used to compare a quote against chunk text. */
export function canonicalForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Return a storable quote if `quote` is a (whitespace/case-insensitive)
 * substring of `source`; otherwise null. Long quotes are cut to a prefix, which
 * is still a substring of the source.
 */
export function verifyQuote(quote: string, source: string): string | null {
  const q = quote.replace(/\s+/g, " ").trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (q.length < MIN_QUOTE_CHARS) return null;
  if (!canonicalForMatch(source).includes(canonicalForMatch(q))) return null;
  if (q.length <= MAX_QUOTE_CHARS) return q;
  const cut = q.slice(0, MAX_QUOTE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > MIN_QUOTE_CHARS ? cut.slice(0, lastSpace) : cut;
}

/** A short excerpt of `text` around the first occurrence of `needle` (case-insensitive). */
export function excerptAround(text: string, needle: string, radius = 140): string | null {
  const flat = text.replace(/\s+/g, " ");
  const idx = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + needle.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

export function clamp01(n: unknown, fallback = 0.5): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(1, Math.max(0, x));
}

/** Order-preserving unique list with a cap. */
export function uniqueCapped<T>(items: Iterable<T>, cap: number, key: (t: T) => string = (t) => String(t)): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}
