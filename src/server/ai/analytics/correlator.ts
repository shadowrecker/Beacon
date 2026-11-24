/**
 * Theme <-> usage-metric correlation.
 *
 * Statistics are computed in code: for each theme we build a time series of
 * how often customers raised it (citations bucketed by the source document's
 * date), and for each imported metric a series of its values; the Pearson
 * correlation over the aligned buckets is the score. The LLM is used only to
 * write a one-sentence narrative per correlation, and if it is unavailable a
 * deterministic sentence is used instead.
 */
import { z } from "zod";
import { prisma, type DbClient } from "@/lib/db";
import { logger } from "@/lib/logger";
import { generateObject } from "@/server/ai/client";
import { untrusted, UNTRUSTED_DATA_POLICY } from "@/server/ai/untrusted";
import type { MetricSeries } from "./importer";

export const MIN_ALIGNED_POINTS = 5;
/** |r| at or above this is stored. */
export const STORE_THRESHOLD = 0.3;
/** |r| at or above this (with enough points) is "strong" and emits correlation.found. */
export const STRONG_THRESHOLD = 0.6;
export const MAX_STORED = 100;
const MAX_NARRATED = 30;

export type Direction = "positive" | "negative" | "neutral";
export type BucketUnit = "day" | "week";

export function directionOf(r: number): Direction {
  if (r >= STORE_THRESHOLD) return "positive";
  if (r <= -STORE_THRESHOLD) return "negative";
  return "neutral";
}

export function isStrong(r: number, n: number): boolean {
  return Math.abs(r) >= STRONG_THRESHOLD && n >= MIN_ALIGNED_POINTS + 1;
}

/** Pearson correlation coefficient, or null when undefined (n<3 or zero variance). */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Math.max(-1, Math.min(1, r));
}

/** Bucket key for a YYYY-MM-DD date: the day itself, or the Monday of its ISO week. */
export function bucketOf(date: string, unit: BucketUnit): string {
  if (unit === "day") return date;
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Daily data spanning at least 6 weeks is compared weekly (less noise); otherwise daily. */
export function chooseUnit(dates: string[]): BucketUnit {
  if (dates.length === 0) return "day";
  const sorted = [...dates].sort();
  const span = (Date.parse(sorted[sorted.length - 1]) - Date.parse(sorted[0])) / 86_400_000;
  return span >= 42 ? "week" : "day";
}

/** Average of metric values per bucket. */
export function bucketMetric(values: Map<string, number>, unit: BucketUnit): Map<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  for (const [date, v] of values) {
    const b = bucketOf(date, unit);
    const cur = sums.get(b) ?? { s: 0, n: 0 };
    cur.s += v;
    cur.n++;
    sums.set(b, cur);
  }
  return new Map([...sums].map(([b, { s, n }]) => [b, s / n]));
}

export interface ThemeMentions {
  /** themeId -> date (YYYY-MM-DD) -> citation count */
  byTheme: Map<string, Map<string, number>>;
  /** All dates on which any cited feedback was received (the observation window). */
  dates: string[];
  truncated: boolean;
}

/** Citation counts per theme per day, by the cited document's date. Bounded. */
export async function loadThemeMentions(projectId: string, themeIds: string[], db: DbClient = prisma, max = 20_000): Promise<ThemeMentions> {
  const rows = await db.citation.findMany({
    where: { themeId: { in: themeIds }, chunk: { projectId } },
    select: { themeId: true, chunk: { select: { document: { select: { createdAt: true } } } } },
    take: max + 1,
  });
  const byTheme = new Map<string, Map<string, number>>();
  const dates = new Set<string>();
  for (const r of rows.slice(0, max)) {
    const date = r.chunk.document.createdAt.toISOString().slice(0, 10);
    dates.add(date);
    const m = byTheme.get(r.themeId) ?? new Map<string, number>();
    m.set(date, (m.get(date) ?? 0) + 1);
    byTheme.set(r.themeId, m);
  }
  return { byTheme, dates: [...dates].sort(), truncated: rows.length > max };
}

export interface CorrelationCandidate {
  themeId: string;
  themeName: string;
  themeDescription: string;
  featureName: string;
  usageMetric: string;
  score: number;
  points: number;
  direction: Direction;
  strong: boolean;
}

export interface CorrelationComputation {
  unit: BucketUnit;
  pairsEvaluated: number;
  pairsWithEnoughData: number;
  candidates: CorrelationCandidate[];
  dropped: number;
}

/**
 * Correlate every theme's mention series with every metric series over the
 * buckets where the metric has data and feedback was being collected.
 */
export function computeCorrelations(input: {
  themes: Array<{ id: string; name: string; description: string }>;
  mentions: ThemeMentions;
  series: MetricSeries[];
}): CorrelationComputation {
  const allDates = [...input.mentions.dates, ...input.series.flatMap((s) => [...s.values.keys()])];
  const unit = chooseUnit(allDates);
  const feedbackBuckets = input.mentions.dates.map((d) => bucketOf(d, unit)).sort();
  const windowStart = feedbackBuckets[0];
  const windowEnd = feedbackBuckets[feedbackBuckets.length - 1];

  const bucketedMentions = new Map<string, Map<string, number>>();
  for (const [themeId, byDate] of input.mentions.byTheme) {
    const m = new Map<string, number>();
    for (const [d, n] of byDate) {
      const b = bucketOf(d, unit);
      m.set(b, (m.get(b) ?? 0) + n);
    }
    bucketedMentions.set(themeId, m);
  }

  let pairsEvaluated = 0;
  let pairsWithEnoughData = 0;
  const all: CorrelationCandidate[] = [];
  if (!windowStart) return { unit, pairsEvaluated, pairsWithEnoughData, candidates: [], dropped: 0 };

  for (const s of input.series) {
    const metric = bucketMetric(s.values, unit);
    const buckets = [...metric.keys()].filter((b) => b >= windowStart && b <= windowEnd).sort();
    for (const theme of input.themes) {
      pairsEvaluated++;
      if (buckets.length < MIN_ALIGNED_POINTS) continue;
      const mentions = bucketedMentions.get(theme.id);
      if (!mentions || mentions.size === 0) continue;
      pairsWithEnoughData++;
      const xs = buckets.map((b) => mentions.get(b) ?? 0);
      const ys = buckets.map((b) => metric.get(b)!);
      const r = pearson(xs, ys);
      if (r === null || Math.abs(r) < STORE_THRESHOLD) continue;
      const score = Math.round(r * 1000) / 1000;
      all.push({
        themeId: theme.id,
        themeName: theme.name,
        themeDescription: theme.description,
        featureName: s.feature,
        usageMetric: s.metric,
        score,
        points: buckets.length,
        direction: directionOf(score),
        strong: isStrong(score, buckets.length),
      });
    }
  }
  all.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.points - a.points);
  return { unit, pairsEvaluated, pairsWithEnoughData, candidates: all.slice(0, MAX_STORED), dropped: Math.max(0, all.length - MAX_STORED) };
}

/** Deterministic description of a correlation (used when no narrative is available). */
export function statisticalInsight(c: CorrelationCandidate, unit: BucketUnit): string {
  const strength = Math.abs(c.score) >= 0.7 ? "strongly" : Math.abs(c.score) >= 0.5 ? "moderately" : "weakly";
  const relation = c.score > 0 ? "rises" : "falls";
  const period = unit === "week" ? "weeks" : "days";
  return `Feedback about "${c.themeName}" ${strength} tracks "${c.featureName}" (${c.usageMetric}): when mentions increase, the metric ${relation} (r = ${c.score.toFixed(2)} over ${c.points} ${period}). Correlation does not imply causation.`;
}

const narrativeSchema = z.object({
  insights: z.array(z.object({ ref: z.string(), insight: z.string() })),
});

const NARRATIVE_SYSTEM = `You are a product analyst. For each correlation between a customer-feedback theme and a product usage metric, write one or two plain sentences a product manager can act on: what the relationship suggests and what to check next. State the correlation coefficient. Never claim causation. Refer to each correlation by its ref (C1, C2, ...) exactly as given.

${UNTRUSTED_DATA_POLICY}`;

/**
 * Narrative insight per candidate (refs map back by index, so the model can't
 * attach text to a pair it wasn't given). Falls back to the statistical
 * sentence for anything the model omits or if the call fails.
 */
export async function narrateCorrelations(
  ctx: { orgId: string; projectId: string },
  candidates: CorrelationCandidate[],
  unit: BucketUnit
): Promise<{ insights: string[]; source: "llm" | "statistical" | "mixed" }> {
  const fallback = candidates.map((c) => statisticalInsight(c, unit));
  const toNarrate = candidates.slice(0, MAX_NARRATED);
  if (toNarrate.length === 0) return { insights: fallback, source: "statistical" };
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const lines = toNarrate.map(
    (c, i) =>
      `C${i + 1}: theme ${untrusted(`theme`, `${cut(c.themeName, 120)}: ${cut(c.themeDescription, 300)}`)}\n    metric: ${untrusted("metric", `${cut(c.featureName, 120)} / ${cut(c.usageMetric, 80)}`)}\n    r = ${c.score.toFixed(3)}, n = ${c.points} ${unit}s, direction ${c.direction}`
  );
  try {
    const out = await generateObject({
      feature: "analytics.correlation_insight",
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      system: NARRATIVE_SYSTEM,
      prompt: `Correlations between how often a theme appears in customer feedback and a usage metric (per ${unit}):\n\n${lines.join("\n\n")}`,
      schema: narrativeSchema,
      tier: "bulk",
      maxTokens: 6_000,
    });
    const insights = [...fallback];
    let used = 0;
    for (const item of out.insights) {
      const m = item.ref.trim().toUpperCase().match(/^C(\d+)$/);
      const idx = m ? Number(m[1]) - 1 : -1;
      const text = item.insight.replace(/\s+/g, " ").trim();
      if (idx >= 0 && idx < toNarrate.length && text) {
        insights[idx] = cut(text, 1_000);
        used++;
      }
    }
    return { insights, source: used === 0 ? "statistical" : used === candidates.length ? "llm" : "mixed" };
  } catch (err) {
    logger.warn("correlation narrative unavailable; using statistical insights", { projectId: ctx.projectId, err });
    return { insights: fallback, source: "statistical" };
  }
}
