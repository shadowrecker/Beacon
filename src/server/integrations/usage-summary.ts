/**
 * Shared helpers for product-analytics connectors (Amplitude, Mixpanel).
 *
 * Analytics providers have no feedback records, so each sync summarizes usage
 * per complete UTC day: one document per day ("daily:YYYY-MM-DD") listing the
 * top events with event and unique-user counts. The cursor is the last day
 * summarized, so each day is written once (and re-written idempotently if a
 * retry recomputes it).
 */
import { z } from "zod";
import type { SyncRecord } from "./types";

export const dayCursorSchema = z.object({ lastDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
}

/**
 * The complete days to summarize this sync: after the cursor (or `backfillDays`
 * back on the first sync), up to yesterday, at most `maxDays`.
 */
export function pendingDays(cursor: unknown, now: Date, backfillDays: number, maxDays: number): { days: string[]; more: boolean } {
  const yesterday = addDays(isoDay(now), -1);
  const parsed = dayCursorSchema.safeParse(cursor);
  const earliest = addDays(isoDay(now), -Math.min(backfillDays, 90));
  let start = parsed.success ? addDays(parsed.data.lastDay, 1) : earliest;
  if (start < earliest) start = earliest;
  const days: string[] = [];
  for (let d = start; d <= yesterday && days.length < maxDays; d = addDays(d, 1)) days.push(d);
  const more = days.length > 0 && days[days.length - 1] < yesterday;
  return { days, more };
}

export interface DailyEventCounts {
  event: string;
  total: number;
  uniques: number | null;
}

export function mapUsageDay(provider: "AMPLITUDE" | "MIXPANEL", label: string, day: string, rows: DailyEventCounts[]): SyncRecord {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const lines = sorted.map(
    (r) => `- ${r.event}: ${r.total.toLocaleString("en-US")} events${r.uniques !== null ? `, ${r.uniques.toLocaleString("en-US")} unique users` : ""}`
  );
  const text = [
    `${label} product usage for ${day} (UTC). Top ${sorted.length} events by volume:`,
    lines.length ? lines.join("\n") : "No tracked events recorded on this day.",
  ].join("\n\n");
  return {
    externalId: `daily:${day}`,
    title: `${label} usage — ${day}`,
    type: "OTHER",
    text,
    sourceUrl: null,
    metadata: { provider, day, events: sorted.length, totalEvents: sorted.reduce((s, r) => s + r.total, 0) },
  };
}

/** Event names are provider data: bound their length and strip control characters. */
export function cleanEventName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || null;
}
