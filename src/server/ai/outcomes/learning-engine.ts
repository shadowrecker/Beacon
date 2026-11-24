/**
 * Learning engine: what kinds of recommendations performed well in a project.
 *
 * Deterministic statistics over measured outcomes (baseline, target and current
 * value all recorded). The resulting LearningSummary is:
 * - returned by outcome.getLearnings for the outcomes page,
 * - turned into a prompt-ready block by getLearningContext(projectId), for the
 *   recommendation generator to include as context, and
 * - used by scoreAdjustment() to calibrate a new recommendation's score by how
 *   similar recommendations (same impact level / confidence band) performed.
 */
import type { RecommendationImpact } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { computeProgress } from "./tracker";

const MAX_OUTCOMES = 500;
/** Minimum measured outcomes before the summary is allowed to move scores. */
export const MIN_MEASURED_FOR_ADJUSTMENT = 3;
const SHRINKAGE = 2;

export type ConfidenceBand = "HIGH" | "MEDIUM" | "LOW";

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.75) return "HIGH";
  if (confidence >= 0.5) return "MEDIUM";
  return "LOW";
}

export interface LearningGroup {
  key: string;
  label: string;
  measured: number;
  /** Outcomes that reached their target (progress >= 1). */
  met: number;
  /** Outcomes that moved toward their target (progress > 0). */
  improved: number;
  successRate: number | null;
  avgProgress: number | null;
}

export interface LearningPerformer {
  recommendationId: string;
  title: string;
  metricName: string | null;
  progress: number;
  impact: RecommendationImpact;
}

export interface LearningSummary {
  tracked: number;
  byStatus: Record<"NOT_SHIPPED" | "SHIPPED" | "MEASURING" | "MEASURED", number>;
  measured: number;
  overall: { successRate: number | null; avgProgress: number | null; met: number; improved: number };
  byImpact: LearningGroup[];
  byConfidence: LearningGroup[];
  bySegment: LearningGroup[];
  topPerformers: LearningPerformer[];
  underperformers: LearningPerformer[];
  decisionsLogged: number;
  insights: string[];
  truncated: boolean;
}

interface Measured {
  recommendationId: string;
  title: string;
  metricName: string | null;
  impact: RecommendationImpact;
  band: ConfidenceBand;
  segments: string[];
  progress: number;
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function group(key: string, label: string, rows: Measured[]): LearningGroup {
  const met = rows.filter((r) => r.progress >= 1).length;
  const improved = rows.filter((r) => r.progress > 0).length;
  return {
    key,
    label,
    measured: rows.length,
    met,
    improved,
    successRate: rows.length ? round(met / rows.length) : null,
    // Cap extreme overshoots so one outlier doesn't dominate the average.
    avgProgress: rows.length ? round(rows.reduce((s, r) => s + Math.max(-2, Math.min(3, r.progress)), 0) / rows.length) : null,
  };
}

const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);

export async function computeLearningSummary(projectId: string, db: DbClient = prisma): Promise<LearningSummary> {
  const [rows, decisionsLogged] = await Promise.all([
    db.outcomeTracking.findMany({
      where: { recommendation: { projectId } },
      orderBy: { updatedAt: "desc" },
      take: MAX_OUTCOMES + 1,
      select: {
        status: true,
        metricName: true,
        baselineValue: true,
        currentValue: true,
        targetValue: true,
        recommendation: { select: { id: true, title: true, impact: true, confidence: true, segments: true } },
      },
    }),
    db.decisionLog.count({ where: { projectId } }),
  ]);
  const truncated = rows.length > MAX_OUTCOMES;
  const outcomes = rows.slice(0, MAX_OUTCOMES);

  const byStatus = { NOT_SHIPPED: 0, SHIPPED: 0, MEASURING: 0, MEASURED: 0 };
  const measured: Measured[] = [];
  for (const o of outcomes) {
    byStatus[o.status]++;
    const progress = computeProgress(o);
    if (progress === null || o.status === "NOT_SHIPPED") continue;
    measured.push({
      recommendationId: o.recommendation.id,
      title: o.recommendation.title,
      metricName: o.metricName,
      impact: o.recommendation.impact,
      band: confidenceBand(o.recommendation.confidence),
      segments: o.recommendation.segments.slice(0, 10),
      progress,
    });
  }

  const overallGroup = group("ALL", "All", measured);
  const byImpact = (["HIGH", "MEDIUM", "LOW"] as const)
    .map((k) => group(k, `${k[0]}${k.slice(1).toLowerCase()} impact`, measured.filter((m) => m.impact === k)))
    .filter((g) => g.measured > 0);
  const byConfidence = (["HIGH", "MEDIUM", "LOW"] as const)
    .map((k) => group(k, `${k[0]}${k.slice(1).toLowerCase()} confidence`, measured.filter((m) => m.band === k)))
    .filter((g) => g.measured > 0);
  const segmentNames = new Map<string, number>();
  for (const m of measured) for (const s of m.segments) segmentNames.set(s, (segmentNames.get(s) ?? 0) + 1);
  const bySegment = [...segmentNames.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([s]) => group(s, s, measured.filter((m) => m.segments.includes(s))));

  const performer = (m: Measured): LearningPerformer => ({
    recommendationId: m.recommendationId,
    title: m.title,
    metricName: m.metricName,
    progress: m.progress,
    impact: m.impact,
  });
  const sorted = [...measured].sort((a, b) => b.progress - a.progress);
  const topPerformers = sorted.filter((m) => m.progress >= 1).slice(0, 5).map(performer);
  const underperformers = sorted.filter((m) => m.progress < 0.5).reverse().slice(0, 5).map(performer);

  const insights: string[] = [];
  if (measured.length === 0) {
    insights.push("No outcomes have been measured yet. Record a baseline, target and current value to start learning.");
  } else {
    insights.push(
      `${overallGroup.met} of ${measured.length} measured recommendations met their target (${pct(overallGroup.successRate)}); ${overallGroup.improved} moved the metric in the right direction.`
    );
    const best = [...byImpact, ...byConfidence].filter((g) => g.measured >= 2).sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0));
    if (best.length >= 2 && best[0].successRate !== best[best.length - 1].successRate) {
      const top = best[0];
      const bottom = best[best.length - 1];
      insights.push(
        `${top.label} recommendations performed best (${top.met}/${top.measured} met target); ${bottom.label.toLowerCase()} performed worst (${bottom.met}/${bottom.measured}).`
      );
    }
    const strongSeg = bySegment.filter((g) => g.measured >= 2).sort((a, b) => (b.successRate ?? 0) - (a.successRate ?? 0))[0];
    if (strongSeg && (strongSeg.successRate ?? 0) > (overallGroup.successRate ?? 0)) {
      insights.push(`Recommendations for the "${strongSeg.label}" segment beat the average (${strongSeg.met}/${strongSeg.measured} met target).`);
    }
  }

  return {
    tracked: outcomes.length,
    byStatus,
    measured: measured.length,
    overall: {
      successRate: overallGroup.successRate,
      avgProgress: overallGroup.avgProgress,
      met: overallGroup.met,
      improved: overallGroup.improved,
    },
    byImpact,
    byConfidence,
    bySegment,
    topPerformers,
    underperformers,
    decisionsLogged,
    insights,
    truncated,
  };
}

/**
 * Score multiplier (0.8–1.2) for a new recommendation, from how recommendations
 * with the same impact level and confidence band performed in this project.
 * Group success rates are shrunk toward the project's overall rate, and the
 * multiplier is 1 until there are enough measured outcomes.
 */
export function scoreAdjustment(summary: LearningSummary, rec: { impact: RecommendationImpact; confidence: number }): number {
  if (summary.measured < MIN_MEASURED_FOR_ADJUSTMENT || summary.overall.successRate === null) return 1;
  const overall = summary.overall.successRate;
  const shrunk = (g: LearningGroup | undefined) =>
    g ? (g.met + SHRINKAGE * overall) / (g.measured + SHRINKAGE) : overall;
  const impactDelta = shrunk(summary.byImpact.find((g) => g.key === rec.impact)) - overall;
  const bandDelta = shrunk(summary.byConfidence.find((g) => g.key === confidenceBand(rec.confidence))) - overall;
  const multiplier = 1 + ((impactDelta + bandDelta) / 2) * 0.6;
  return round(Math.max(0.8, Math.min(1.2, multiplier)));
}

/**
 * Prompt-ready summary of past outcomes for recommendation generation, or null
 * when nothing has been measured. Contains only aggregate statistics and
 * recommendation titles written by Beacon (no customer text).
 */
export function learningContextFromSummary(summary: LearningSummary): string | null {
  if (summary.measured === 0) return null;
  const lines = [
    `Past outcomes in this project (${summary.measured} measured):`,
    `- Overall: ${summary.overall.met}/${summary.measured} met target (${pct(summary.overall.successRate)}).`,
    ...summary.byImpact.map((g) => `- ${g.label}: ${g.met}/${g.measured} met target.`),
    ...summary.byConfidence.map((g) => `- ${g.label}: ${g.met}/${g.measured} met target.`),
  ];
  if (summary.topPerformers.length) {
    lines.push(`- Worked well: ${summary.topPerformers.slice(0, 3).map((p) => `"${p.title.slice(0, 80)}"`).join("; ")}.`);
  }
  if (summary.underperformers.length) {
    lines.push(`- Underperformed: ${summary.underperformers.slice(0, 3).map((p) => `"${p.title.slice(0, 80)}"`).join("; ")}.`);
  }
  lines.push("Favor recommendation types that have met their targets, and be explicit about evidence when proposing types that underperformed.");
  return lines.join("\n");
}

/** Learning context for a project (for the recommendation generator). */
export async function getLearningContext(projectId: string, db: DbClient = prisma): Promise<string | null> {
  return learningContextFromSummary(await computeLearningSummary(projectId, db));
}
