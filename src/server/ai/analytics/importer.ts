/**
 * Analytics importer: usage metrics from a CSV or a connected Amplitude /
 * Mixpanel integration, normalized to daily metric points.
 *
 * - Credentials come only from the org's own integration
 *   (getOrgIntegrationCredentials(project.orgId, provider)); callers verify that
 *   any integrationId in the request belongs to that org first.
 * - Provider hosts are fixed (US or EU data center per the integration config)
 *   and every request goes through safeFetch.
 * - Bounded: date range at most MAX_RANGE_DAYS, at most MAX_EVENTS events per
 *   provider import, at most MAX_POINTS points per import.
 *
 * Stored AnalyticsImport.data shape (version 1):
 *   { version, summary: { points, series, features, metrics, start, end, skipped, truncated }, points: MetricPoint[] }
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, type DbClient } from "@/lib/db";
import { safeFetch } from "@/lib/safe-fetch";
import { NonRetryableError } from "@/server/jobs/worker";
import { getOrgIntegrationCredentials, type Credentials } from "@/server/integrations/credentials";
import { CsvError, findColumn, parseCsv } from "../roadmap/csv";

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_POINTS = 10_000;
export const MAX_RANGE_DAYS = 90;
export const MAX_EVENTS = 15;
const REQUEST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const metricPointSchema = z.object({
  feature: z.string().min(1).max(200),
  metric: z.string().min(1).max(100),
  date: z.string().regex(DATE_RE),
  value: z.number(),
  segment: z.string().max(100).nullable(),
});
export type MetricPoint = z.infer<typeof metricPointSchema>;

export const analyticsDataSchema = z.object({
  version: z.literal(1),
  summary: z.object({
    points: z.number().int(),
    series: z.number().int(),
    features: z.number().int(),
    metrics: z.number().int(),
    start: z.string().nullable(),
    end: z.string().nullable(),
    skipped: z.number().int(),
    truncated: z.boolean(),
  }),
  points: z.array(metricPointSchema),
});
export type AnalyticsData = z.infer<typeof analyticsDataSchema>;
export type AnalyticsSummary = AnalyticsData["summary"];

export class AnalyticsImportError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsImportError";
  }
}

export interface DateRange {
  start: string;
  end: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** Normalize a date cell to YYYY-MM-DD (UTC), or null. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(iso[3])) return null;
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{8}$/.test(s)) return normalizeDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

export function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/[,\s$€£%]/g, "");
  if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Validate an import date range: YYYY-MM-DD, start <= end <= today, span <= MAX_RANGE_DAYS. */
export function validateRange(range: DateRange, now = new Date()): DateRange {
  const start = normalizeDate(range.start);
  const end = normalizeDate(range.end);
  if (!start || !end || !DATE_RE.test(range.start) || !DATE_RE.test(range.end)) {
    throw new AnalyticsImportError("Dates must be in YYYY-MM-DD format");
  }
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (s > e) throw new AnalyticsImportError("The start date must be on or before the end date");
  if (e > today) throw new AnalyticsImportError("The end date cannot be in the future");
  const days = Math.round((e - s) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) throw new AnalyticsImportError(`The date range can be at most ${MAX_RANGE_DAYS} days`);
  return { start, end };
}

function cred(credentials: Credentials, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = credentials[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function region(config: unknown): "US" | "EU" {
  const r = config && typeof config === "object" ? (config as { region?: unknown }).region : undefined;
  return typeof r === "string" && r.toUpperCase() === "EU" ? "EU" : "US";
}

function upstreamError(provider: string, status: number): Error {
  const err = new Error(`${provider} request failed with status ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Build the stored data blob (bounded) with a summary for cheap listing. */
export function buildAnalyticsData(points: MetricPoint[], skipped: number, truncated: boolean): AnalyticsData {
  const kept = points.slice(0, MAX_POINTS);
  const dates = kept.map((p) => p.date).sort();
  const series = new Set(kept.map((p) => `${p.feature}\u0000${p.metric}\u0000${p.segment ?? ""}`));
  return {
    version: 1,
    summary: {
      points: kept.length,
      series: series.size,
      features: new Set(kept.map((p) => p.feature)).size,
      metrics: new Set(kept.map((p) => p.metric)).size,
      start: dates[0] ?? null,
      end: dates[dates.length - 1] ?? null,
      skipped,
      truncated: truncated || points.length > MAX_POINTS,
    },
    points: kept,
  };
}

// ---------------------------------------------------------------------------
// CSV: feature, metric, value, date[, segment]
// ---------------------------------------------------------------------------

export function parseAnalyticsCsv(text: string): { points: MetricPoint[]; skipped: Array<{ row: number; reason: string }>; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) {
    throw new AnalyticsImportError(`The CSV file is larger than ${MAX_CSV_BYTES / (1024 * 1024)} MB`);
  }
  let parsed;
  try {
    parsed = parseCsv(text, { maxRows: MAX_POINTS, maxColumns: 30, maxFieldLength: 1_000 });
  } catch (err) {
    if (err instanceof CsvError) throw new AnalyticsImportError(err.message);
    throw err;
  }
  const { header, rows, truncated } = parsed;
  const col = {
    feature: findColumn(header, ["feature", "feature_name", "featureName", "event", "event_name"]),
    metric: findColumn(header, ["metric", "metric_name", "metricName", "measure"]),
    value: findColumn(header, ["value", "count", "amount"]),
    date: findColumn(header, ["date", "day", "timestamp"]),
    segment: findColumn(header, ["segment", "cohort"]),
  };
  const missing = (["feature", "metric", "value", "date"] as const).filter((k) => col[k] < 0);
  if (missing.length) {
    throw new AnalyticsImportError(`The CSV is missing required column(s): ${missing.join(", ")}`);
  }
  const points: MetricPoint[] = [];
  const skipped: Array<{ row: number; reason: string }> = [];
  rows.forEach((row, i) => {
    const line = i + 2;
    const feature = clip(row[col.feature], 200);
    const metric = clip(row[col.metric], 100);
    if (!feature || !metric) return void skipped.push({ row: line, reason: "missing feature or metric" });
    const value = parseNumber(row[col.value] ?? "");
    if (value === null) return void skipped.push({ row: line, reason: "value is not a number" });
    const date = normalizeDate(row[col.date] ?? "");
    if (!date) return void skipped.push({ row: line, reason: "invalid date" });
    const segment = col.segment >= 0 ? clip(row[col.segment], 100) || null : null;
    points.push({ feature, metric, value, date, segment });
  });
  return { points, skipped, truncated };
}

// ---------------------------------------------------------------------------
// Amplitude (Dashboard REST API: events list + event segmentation, uniques/day)
// ---------------------------------------------------------------------------

export async function fetchAmplitudePoints(orgId: string, range: DateRange): Promise<{ points: MetricPoint[]; skipped: number; truncated: boolean }> {
  const integ = await getOrgIntegrationCredentials(orgId, "AMPLITUDE");
  if (!integ) throw new AnalyticsImportError("Amplitude is not connected for this workspace");
  const apiKey = cred(integ.credentials, "apiKey", "api_key");
  const secretKey = cred(integ.credentials, "secretKey", "secret_key");
  if (!apiKey || !secretKey) throw new AnalyticsImportError("Amplitude credentials are incomplete");
  const base = region(integ.config) === "EU" ? "https://analytics.eu.amplitude.com" : "https://amplitude.com";
  const headers = { authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString("base64")}`, accept: "application/json" };
  const { start, end } = validateRange(range);

  const list = await safeFetch(`${base}/api/2/events/list`, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
  if (!list.ok) throw upstreamError("Amplitude", list.status);
  const events = (list.json<{ data?: Array<{ value?: string; name?: string; totals?: number; hidden?: boolean; deleted?: boolean; non_active?: boolean }> }>().data ?? [])
    .filter((e) => !e.hidden && !e.deleted && !e.non_active && (e.value ?? e.name))
    .sort((a, b) => (b.totals ?? 0) - (a.totals ?? 0));
  const chosen = events.slice(0, MAX_EVENTS).map((e) => (e.value ?? e.name)!.slice(0, 200));
  const truncated = events.length > MAX_EVENTS;

  const compact = (d: string) => d.replace(/-/g, "");
  const perEvent = await mapPool(chosen, CONCURRENCY, async (eventType) => {
    const qs = new URLSearchParams({
      e: JSON.stringify({ event_type: eventType }),
      m: "uniques",
      start: compact(start),
      end: compact(end),
      i: "1",
    });
    const res = await safeFetch(`${base}/api/2/events/segmentation?${qs.toString()}`, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!res.ok) throw upstreamError("Amplitude", res.status);
    const body = res.json<{ data?: { series?: number[][]; xValues?: string[] } }>();
    const xs = body.data?.xValues ?? [];
    const ys = body.data?.series?.[0] ?? [];
    const pts: MetricPoint[] = [];
    xs.forEach((x, i) => {
      const date = normalizeDate(x);
      const value = ys[i];
      if (date && typeof value === "number" && Number.isFinite(value)) {
        pts.push({ feature: eventType, metric: "unique_users", date, value, segment: null });
      }
    });
    return pts;
  });
  const points = perEvent.flat();
  return { points, skipped: 0, truncated: truncated || points.length > MAX_POINTS };
}

// ---------------------------------------------------------------------------
// Mixpanel (Query API: top event names + daily unique counts)
// ---------------------------------------------------------------------------

export async function fetchMixpanelPoints(orgId: string, range: DateRange): Promise<{ points: MetricPoint[]; skipped: number; truncated: boolean }> {
  const integ = await getOrgIntegrationCredentials(orgId, "MIXPANEL");
  if (!integ) throw new AnalyticsImportError("Mixpanel is not connected for this workspace");
  const c = integ.credentials;
  const username = cred(c, "serviceAccountUsername", "username");
  const secret = cred(c, "serviceAccountSecret", "secret", "password");
  const apiSecret = cred(c, "apiSecret", "api_secret");
  const projectId = cred(c, "projectId", "project_id");
  if (!projectId || !/^\d{1,20}$/.test(projectId)) throw new AnalyticsImportError("Mixpanel project ID is missing or invalid");
  const basic = username && secret ? `${username}:${secret}` : apiSecret ? `${apiSecret}:` : null;
  if (!basic) throw new AnalyticsImportError("Mixpanel credentials are incomplete");
  const base = region(integ.config) === "EU" ? "https://eu.mixpanel.com" : "https://mixpanel.com";
  const headers = { authorization: `Basic ${Buffer.from(basic).toString("base64")}`, accept: "application/json" };
  const { start, end } = validateRange(range);

  const namesQs = new URLSearchParams({ project_id: projectId, type: "general", limit: String(MAX_EVENTS + 1) });
  const namesRes = await safeFetch(`${base}/api/query/events/names?${namesQs.toString()}`, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
  if (!namesRes.ok) throw upstreamError("Mixpanel", namesRes.status);
  const allNames = namesRes.json<unknown>();
  const names = (Array.isArray(allNames) ? allNames : []).filter((n): n is string => typeof n === "string" && n.length > 0);
  const chosen = names.slice(0, MAX_EVENTS).map((n) => n.slice(0, 200));
  if (chosen.length === 0) return { points: [], skipped: 0, truncated: false };

  const qs = new URLSearchParams({
    project_id: projectId,
    event: JSON.stringify(chosen),
    type: "unique",
    unit: "day",
    from_date: start,
    to_date: end,
  });
  const res = await safeFetch(`${base}/api/query/events?${qs.toString()}`, { headers, timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: 10 * 1024 * 1024 });
  if (!res.ok) throw upstreamError("Mixpanel", res.status);
  const body = res.json<{ data?: { values?: Record<string, Record<string, number>> } }>();
  const points: MetricPoint[] = [];
  for (const [event, byDate] of Object.entries(body.data?.values ?? {})) {
    if (!chosen.includes(event)) continue;
    for (const [d, value] of Object.entries(byDate ?? {})) {
      const date = normalizeDate(d);
      if (date && typeof value === "number" && Number.isFinite(value)) {
        points.push({ feature: event, metric: "unique_users", date, value, segment: null });
      }
    }
  }
  return { points, skipped: 0, truncated: names.length > MAX_EVENTS || points.length > MAX_POINTS };
}

// ---------------------------------------------------------------------------
// Reading imported data back (bounded)
// ---------------------------------------------------------------------------

export interface MetricSeries {
  key: string;
  feature: string;
  /** Metric name, suffixed with the segment for segmented points. */
  metric: string;
  /** date (YYYY-MM-DD) -> value; newer imports win for the same date. */
  values: Map<string, number>;
}

export function seriesKey(feature: string, metric: string): string {
  return `${feature}\u0000${metric}`;
}

function seriesMetricName(p: MetricPoint): string {
  return p.segment ? `${p.metric} · ${p.segment}`.slice(0, 100) : p.metric;
}

/**
 * Load the project's metric series from its most recent imports. Bounded by
 * import count and total points; for duplicate (series, date) points the most
 * recent import wins.
 */
export async function loadProjectSeries(
  projectId: string,
  opts: { maxImports?: number; maxPoints?: number; maxSeries?: number } = {},
  db: DbClient = prisma
): Promise<{ series: MetricSeries[]; importsUsed: number; pointsSkipped: number }> {
  const maxPoints = opts.maxPoints ?? 30_000;
  const maxSeries = opts.maxSeries ?? 60;
  const imports = await db.analyticsImport.findMany({
    where: { projectId },
    orderBy: [{ importedAt: "desc" }, { id: "desc" }],
    take: opts.maxImports ?? 10,
    select: { data: true },
  });
  const byKey = new Map<string, MetricSeries>();
  let loaded = 0;
  let pointsSkipped = 0;
  for (const imp of imports) {
    const parsed = analyticsDataSchema.safeParse(imp.data);
    if (!parsed.success) continue;
    for (const p of parsed.data.points) {
      if (loaded >= maxPoints) {
        pointsSkipped++;
        continue;
      }
      const metric = seriesMetricName(p);
      const key = seriesKey(p.feature, metric);
      let s = byKey.get(key);
      if (!s) {
        if (byKey.size >= maxSeries * 4) {
          pointsSkipped++;
          continue;
        }
        s = { key, feature: p.feature, metric, values: new Map() };
        byKey.set(key, s);
      }
      if (!s.values.has(p.date)) {
        s.values.set(p.date, p.value);
        loaded++;
      }
    }
  }
  // Keep the series with the most data.
  const series = [...byKey.values()].sort((a, b) => b.values.size - a.values.size);
  for (const dropped of series.slice(maxSeries)) pointsSkipped += dropped.values.size;
  return { series: series.slice(0, maxSeries), importsUsed: imports.length, pointsSkipped };
}

export function toJson(data: AnalyticsData): Prisma.InputJsonValue {
  return data as unknown as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Shared import path (router CSV imports and the background import worker)
// ---------------------------------------------------------------------------

export const INTEGRATION_ANALYTICS_SOURCES = ["AMPLITUDE", "MIXPANEL"] as const;
export type IntegrationAnalyticsSource = (typeof INTEGRATION_ANALYTICS_SOURCES)[number];
export const ANALYTICS_SOURCE_LABEL: Record<"CSV" | IntegrationAnalyticsSource, string> = {
  CSV: "CSV",
  AMPLITUDE: "Amplitude",
  MIXPANEL: "Mixpanel",
};

/** Validated parameters of an integration import (stored as JobRun.input, kind ANALYTICS_IMPORT). */
export const analyticsImportJobInputSchema = z.object({
  source: z.enum(INTEGRATION_ANALYTICS_SOURCES),
  integrationId: z.string().min(1).max(64),
  startDate: z.string().regex(DATE_RE),
  endDate: z.string().regex(DATE_RE),
});
export type AnalyticsImportJobInput = z.infer<typeof analyticsImportJobInputSchema>;

export async function fetchIntegrationAnalyticsPoints(
  orgId: string,
  params: AnalyticsImportJobInput
): Promise<{ points: MetricPoint[]; skipped: number; truncated: boolean }> {
  const range = validateRange({ start: params.startDate, end: params.endDate });
  return params.source === "AMPLITUDE" ? fetchAmplitudePoints(orgId, range) : fetchMixpanelPoints(orgId, range);
}

export interface AnalyticsImportResult {
  importId: string;
  source: "CSV" | IntegrationAnalyticsSource;
  importedAt: Date;
  summary: AnalyticsSummary;
}

/**
 * Store one import (bounded, with its summary). Pass a transaction client so
 * the worker can commit it together with the JobRun's READY state, which makes
 * a retried job unable to store the same import twice.
 */
export async function saveAnalyticsImport(
  db: DbClient,
  input: {
    projectId: string;
    source: "CSV" | IntegrationAnalyticsSource;
    integrationId: string | null;
    points: MetricPoint[];
    skipped: number;
    truncated: boolean;
  }
): Promise<AnalyticsImportResult> {
  const label = ANALYTICS_SOURCE_LABEL[input.source];
  if (input.points.length === 0) {
    throw new AnalyticsImportError(
      input.source === "CSV" ? "No valid metric rows were found in the CSV" : `${label} returned no usage data for that date range`
    );
  }
  const data = buildAnalyticsData(input.points, input.skipped, input.truncated);
  const row = await db.analyticsImport.create({
    data: { projectId: input.projectId, source: input.source, integrationId: input.integrationId, data: toJson(data) },
    select: { id: true, source: true, importedAt: true },
  });
  if (input.integrationId) {
    // Don't touch lastSyncAt: it drives the scheduled document sync for this
    // integration, and a manual analytics import is a different read.
    await db.integration.update({ where: { id: input.integrationId }, data: { lastError: null } });
  }
  return { importId: row.id, source: input.source, importedAt: row.importedAt, summary: data.summary };
}
