/**
 * Pure aggregation of per-chunk classifications into snapshot figures.
 */
import type { RiskLevel } from "@prisma/client";
import type { ChunkSentiment } from "./classify";

export interface ThemeStat {
  name: string;
  count: number;
  positive: number;
  neutral: number;
  negative: number;
  averageScore: number;
}

export interface SnapshotFigures {
  volume: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  /** Mean score in [-1, 1], 3 decimals. */
  overallScore: number;
  riskLevel: RiskLevel;
  topThemes: ThemeStat[];
}

const TOP_THEMES = 10;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function riskLevelFor(score: number, negativeShare: number): RiskLevel {
  if (score <= -0.5 || negativeShare >= 0.6) return "CRITICAL";
  if (score <= -0.2 || negativeShare >= 0.4) return "HIGH";
  if (score < 0.1 || negativeShare >= 0.25) return "MEDIUM";
  return "LOW";
}

export function aggregate(items: Array<Pick<ChunkSentiment, "label" | "score" | "themes">>): SnapshotFigures {
  let pos = 0;
  let neu = 0;
  let neg = 0;
  let sum = 0;
  const themes = new Map<string, ThemeStat & { scoreSum: number }>();
  for (const it of items) {
    if (it.label === "POSITIVE") pos++;
    else if (it.label === "NEGATIVE") neg++;
    else neu++;
    sum += it.score;
    for (const t of it.themes) {
      const key = t.toLowerCase();
      const cur = themes.get(key) ?? { name: t, count: 0, positive: 0, neutral: 0, negative: 0, averageScore: 0, scoreSum: 0 };
      cur.count++;
      cur.scoreSum += it.score;
      if (it.label === "POSITIVE") cur.positive++;
      else if (it.label === "NEGATIVE") cur.negative++;
      else cur.neutral++;
      themes.set(key, cur);
    }
  }
  const volume = items.length;
  const overallScore = volume > 0 ? round3(sum / volume) : 0;
  const negativeShare = volume > 0 ? neg / volume : 0;
  const topThemes = [...themes.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, TOP_THEMES)
    .map(({ scoreSum, ...t }) => ({ ...t, averageScore: round3(scoreSum / t.count) }));
  return {
    volume,
    positiveCount: pos,
    neutralCount: neu,
    negativeCount: neg,
    overallScore,
    riskLevel: riskLevelFor(overallScore, negativeShare),
    topThemes,
  };
}

/** Minimum items for a segment snapshot, and the most segments stored per period. */
export const MIN_SEGMENT_VOLUME = 3;
export const MAX_SEGMENTS = 12;

/** Per-segment figures for segments with enough volume (largest first). */
export function aggregateBySegment<T extends Pick<ChunkSentiment, "label" | "score" | "themes">>(
  items: Array<T & { segment: string | null }>
): Array<{ segment: string; figures: SnapshotFigures }> {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    if (!it.segment || it.segment === "all") continue;
    const list = groups.get(it.segment) ?? [];
    list.push(it);
    groups.set(it.segment, list);
  }
  return [...groups.entries()]
    .filter(([, list]) => list.length >= MIN_SEGMENT_VOLUME)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_SEGMENTS)
    .map(([segment, list]) => ({ segment, figures: aggregate(list) }));
}
