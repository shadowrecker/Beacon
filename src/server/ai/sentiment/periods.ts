/**
 * Sentiment period windows (UTC). A window is [start, end): DAILY starts at
 * midnight, WEEKLY on Monday (ISO weeks), MONTHLY on the 1st. Snapshots store
 * `periodEnd` as the exclusive end.
 */
import type { SentimentPeriod } from "@prisma/client";

export interface PeriodWindow {
  period: SentimentPeriod;
  start: Date;
  end: Date;
}

const DAY_MS = 24 * 3600 * 1000;

/** Start of the period that contains `at`. */
export function periodStartFor(period: SentimentPeriod, at: Date): Date {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  if (period === "MONTHLY") return new Date(Date.UTC(y, m, 1));
  const day = new Date(Date.UTC(y, m, d));
  if (period === "DAILY") return day;
  const isoDow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - isoDow * DAY_MS);
}

export function addPeriods(period: SentimentPeriod, start: Date, n: number): Date {
  if (period === "MONTHLY") return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, 1));
  return new Date(start.getTime() + n * (period === "DAILY" ? 1 : 7) * DAY_MS);
}

export function windowFor(period: SentimentPeriod, at: Date): PeriodWindow {
  const start = periodStartFor(period, at);
  return { period, start, end: addPeriods(period, start, 1) };
}

/** The most recent period that has fully ended before `now`. */
export function lastCompleteWindow(period: SentimentPeriod, now: Date): PeriodWindow {
  const current = periodStartFor(period, now);
  const start = addPeriods(period, current, -1);
  return { period, start, end: current };
}

export function periodKey(w: Pick<PeriodWindow, "period" | "start">): string {
  return `${w.period}:${w.start.toISOString()}`;
}

export function describeWindow(w: PeriodWindow): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const lastDay = new Date(w.end.getTime() - DAY_MS);
  return w.period === "DAILY" ? fmt(w.start) : `${fmt(w.start)} to ${fmt(lastDay)}`;
}
