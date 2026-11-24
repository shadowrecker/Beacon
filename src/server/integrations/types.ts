/**
 * Connector contract shared by all 12 providers.
 *
 * A connector turns provider API records into `SyncRecord`s. The sync engine
 * (sync.ts) ingests each record through createDocumentFromText (idempotent on
 * integrationId + externalId) and persists the connector's cursor after every
 * batch, so a retried or capped sync resumes where it stopped instead of
 * starting over.
 */
import type { DocumentType, IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import type { Logger } from "@/lib/logger";
import type { Credentials } from "./credentials";
import type { ProviderHttp } from "./http";

export type AuthKind = "oauth" | "apiKey";

export interface SyncRecord {
  externalId: string;
  title: string;
  type: DocumentType;
  text: string;
  sourceUrl?: string | null;
  /** Small, JSON-safe metadata stored on the document. */
  metadata?: Record<string, string | number | boolean | null | string[]>;
}

export interface SyncBatch {
  records: SyncRecord[];
  /** Cursor to persist once this batch has been ingested. */
  cursor: unknown;
  /** True when this batch reached the end of the available data. */
  done: boolean;
}

export interface SyncLimits {
  /** Max API pages fetched per sync (per channel/stream for multi-stream providers). */
  maxPages: number;
  /** Max records ingested per sync. */
  maxRecords: number;
}

export const DEFAULT_LIMITS: SyncLimits = { maxPages: 10, maxRecords: 500 };

export interface SyncContext<Config = Record<string, unknown>> {
  integrationId: string;
  credentials: Credentials;
  config: Config;
  /** Previously persisted cursor (validated by the connector), or null for a first sync. */
  cursor: unknown;
  http: ProviderHttp;
  limits: SyncLimits;
  /** Days of history to fetch on the first sync. */
  backfillDays: number;
  now: Date;
  log: Logger;
}

export interface TestResult {
  /** Human label for the connected account (workspace name, site...). */
  accountLabel?: string;
  /** Server-derived account details merged into config.account (ids used to build links). */
  account?: Record<string, string>;
}

export interface Connector<Config = Record<string, unknown>> {
  provider: IntegrationProvider;
  auth: AuthKind;
  /** User-editable provider settings (validated on connect and update). */
  configSchema: z.ZodType<Config>;
  /** API-token providers: the credential fields accepted on connect. */
  credentialSchema?: z.ZodType<Credentials>;
  /** Auth headers for API requests with these credentials. */
  authHeaders(credentials: Credentials, config: Config): Record<string, string>;
  /** Live check that the credentials work. Throws ProviderAuthError/ProviderError when not. */
  testConnection(http: ProviderHttp, credentials: Credentials, config: Config): Promise<TestResult>;
  /** Fetch records since the cursor, yielding batches. */
  sync(ctx: SyncContext<Config>): AsyncGenerator<SyncBatch>;
}

// ---------------------------------------------------------------------------
// Windowed cursor: works regardless of the order a provider returns records in.
//
//   since      lower bound of the current window (records updated after it)
//   after      provider page cursor inside the window (set when a sync was capped)
//   highWater  newest timestamp seen in the current window
//
// When a window is exhausted, the next window starts at highWater.
// ---------------------------------------------------------------------------

export const windowCursorSchema = z.object({
  since: z.string().nullable(),
  after: z.string().max(4000).nullable(),
  highWater: z.string().nullable(),
});
export type WindowCursor = z.infer<typeof windowCursorSchema>;

export function readWindow(cursor: unknown, now: Date, backfillDays: number): WindowCursor {
  const parsed = windowCursorSchema.safeParse(cursor);
  if (parsed.success && parsed.data.since) return parsed.data;
  return { since: new Date(now.getTime() - backfillDays * 86_400_000).toISOString(), after: null, highWater: null };
}

export function maxIso(a: string | null, b: string | null | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** Cursor after a page: continue the window, or close it when there is no next page. */
export function advanceWindow(w: WindowCursor, next: string | null, highWater: string | null): WindowCursor {
  if (next) return { since: w.since, after: next, highWater };
  return { since: highWater ?? w.since, after: null, highWater: null };
}

/** ISO string from a unix timestamp (seconds) or a parseable date; null if invalid. */
export function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

/** Keep only http(s) URLs on an allowlisted host suffix (used for provider-supplied links). */
export function safeLink(raw: unknown, hostSuffixes: string[]): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    if (!hostSuffixes.some((s) => host === s || host.endsWith(`.${s}`))) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First non-empty line of text, clipped, for use as a title. */
export function titleFrom(text: string, fallback: string, max = 120): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean);
  return clip(line ?? fallback, max) || fallback;
}

export const syncIntervalSchema = z.number().int().min(60).max(10_080);

/** Settings every provider accepts. */
export const commonConfigShape = {
  syncIntervalMinutes: syncIntervalSchema.optional(),
  backfillDays: z.number().int().min(1).max(365).optional(),
};
