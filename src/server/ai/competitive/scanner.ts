/**
 * Competitor page fetching and section extraction.
 *
 * Fetches the competitor's site root plus well-known changelog, blog and pricing
 * paths (and the optional capture URL) through safeFetch: HTTPS only, private
 * and metadata addresses refused, redirects re-validated, size and time capped.
 * Pages are parsed into readable text with the HTML parser (scripts, styles,
 * navigation and chrome removed) and split into content sections, each with a
 * stable content hash for de-duplication across scans.
 */
import type { CompetitorUpdateType } from "@prisma/client";
import { sha256Hex } from "@/lib/crypto";
import { safeFetch, SafeFetchError, type SafeFetchResponse } from "@/lib/safe-fetch";
import { extractReadable } from "./html";

export type PageKind = "HOME" | "CHANGELOG" | "PRESS" | "PRICING" | "CAPTURE";

export const SCAN_PATHS: Array<{ path: string; kind: PageKind }> = [
  { path: "/", kind: "HOME" },
  { path: "/changelog", kind: "CHANGELOG" },
  { path: "/release-notes", kind: "CHANGELOG" },
  { path: "/whats-new", kind: "CHANGELOG" },
  { path: "/blog", kind: "PRESS" },
  { path: "/news", kind: "PRESS" },
  { path: "/pricing", kind: "PRICING" },
];

export type PageFetcher = (url: string) => Promise<SafeFetchResponse>;

const defaultFetcher: PageFetcher = (url) =>
  safeFetch(url, {
    allowHttp: false,
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
    maxRedirects: 4,
    headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "accept-language": "en" },
  });

let fetcher: PageFetcher = defaultFetcher;

/** Test-only: replace the page fetcher (null restores safeFetch). */
export function setCompetitorFetcherForTests(f: PageFetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

/** http(s) only; returns the https form (scans never use plain http). */
export function toHttpsUrl(raw: string | null | undefined): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  u.protocol = "https:";
  u.hash = "";
  return u;
}

export interface FetchedPage {
  url: string;
  path: string;
  kind: PageKind;
  title: string | null;
  description: string | null;
  text: string;
  sections: Array<{ heading: string | null; text: string }>;
}

export interface PageError {
  url: string;
  reason: string;
  transient: boolean;
}

export async function fetchCompetitorPages(website: string | null, captureUrl: string | null): Promise<{ pages: FetchedPage[]; errors: PageError[]; attempted: number }> {
  const targets: Array<{ url: string; kind: PageKind }> = [];
  const site = toHttpsUrl(website);
  if (site) for (const p of SCAN_PATHS) targets.push({ url: `${site.origin}${p.path}`, kind: p.kind });
  const capture = toHttpsUrl(captureUrl);
  if (capture && !targets.some((t) => t.url === capture.toString())) targets.push({ url: capture.toString(), kind: "CAPTURE" });

  const pages: FetchedPage[] = [];
  const errors: PageError[] = [];
  const seenFinal = new Set<string>();
  const seenText = new Set<string>();

  const processTarget = async (t: { url: string; kind: PageKind }): Promise<void> => {
      try {
        const res = await fetcher(t.url);
        if (res.status === 404 || res.status === 410) return; // path doesn't exist on this site
        if (!res.ok) {
          errors.push({ url: t.url, reason: `HTTP ${res.status}`, transient: res.status >= 500 || res.status === 429 });
          return;
        }
        const type = res.headers.get("content-type") ?? "";
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
          if (t.kind === "HOME" || t.kind === "CAPTURE") errors.push({ url: t.url, reason: "Not an HTML page", transient: false });
          return;
        }
        const finalUrl = res.url.replace(/#.*$/, "");
        // A missing path often redirects to the homepage: don't treat it as its own page.
        if (t.kind !== "CAPTURE" && seenFinal.has(finalUrl)) return;
        const readable = extractReadable(res.text(), { mode: "page", maxChars: 200_000 });
        const textKey = sha256Hex(readable.text);
        if (seenText.has(textKey)) return;
        seenFinal.add(finalUrl);
        seenText.add(textKey);
        pages.push({
          url: finalUrl,
          path: new URL(finalUrl).pathname,
          kind: t.kind,
          title: readable.title,
          description: readable.description,
          text: readable.text,
          sections: readable.sections.map((s) => ({ heading: s.heading, text: s.text })),
        });
      } catch (err) {
        const code = err instanceof SafeFetchError ? err.code : "NETWORK";
        errors.push({
          url: t.url,
          reason: code === "BLOCKED_ADDRESS" || code === "BLOCKED_PROTOCOL" ? "Address not allowed" : code.toLowerCase().replace(/_/g, " "),
          transient: code === "TIMEOUT" || code === "NETWORK",
        });
      }
  };

  // The homepage first (so redirects to it are recognized), then the rest with
  // small concurrency to be polite to the competitor's site.
  const queue = [...targets];
  if (queue[0]?.kind === "HOME") await processTarget(queue.shift()!);
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) await processTarget(t);
    })
  );
  // Keep a deterministic order (scan path order).
  const order = new Map(targets.map((t, i) => [t.url, i]));
  pages.sort((a, b) => (order.get(a.url) ?? 99) - (order.get(b.url) ?? 99));
  return { pages, errors, attempted: targets.length };
}

export interface Candidate {
  hash: string;
  pageUrl: string;
  pageKind: PageKind;
  heading: string | null;
  text: string;
  /** Default update type implied by the page. */
  defaultType: CompetitorUpdateType;
}

const MAX_SECTIONS_PER_PAGE = 20;
const MAX_CANDIDATES = 60;
const SECTION_CHARS = 3_000;
const MIN_SECTION_CHARS = 60;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function contentHash(kind: string, heading: string | null, text: string): string {
  return sha256Hex(`${kind}|${normalize(heading ?? "")}|${normalize(text)}`);
}

const DEFAULT_TYPE: Record<PageKind, CompetitorUpdateType> = {
  HOME: "FEATURE",
  CHANGELOG: "CHANGELOG",
  PRESS: "PRESS",
  PRICING: "PRICING",
  CAPTURE: "FEATURE",
};

/** Split fetched pages into hashed candidate sections (whole page for home/pricing). */
export function extractCandidates(pages: FetchedPage[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const whole = page.kind === "HOME" || page.kind === "PRICING";
    const parts = whole
      ? [{ heading: page.title, text: page.text }]
      : page.sections.filter((s) => s.text.length >= MIN_SECTION_CHARS).slice(0, MAX_SECTIONS_PER_PAGE);
    for (const part of parts) {
      const text = part.text.slice(0, whole ? SECTION_CHARS * 2 : SECTION_CHARS);
      if (text.length < MIN_SECTION_CHARS) continue;
      const hash = contentHash(page.kind, part.heading, text);
      if (seen.has(hash)) continue;
      seen.add(hash);
      out.push({ hash, pageUrl: page.url, pageKind: page.kind, heading: part.heading, text, defaultType: DEFAULT_TYPE[page.kind] });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}
