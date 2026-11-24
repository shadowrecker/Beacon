/**
 * Anomaly detection for a new snapshot against the previous snapshots of the
 * same project/period/segment (most recent first, current excluded).
 *
 * - SPIKE_NEGATIVE: negative share well above its recent mean (z ≥ 2 and +15 pts).
 * - TREND_DECLINE: score z ≤ -2 vs history, or three consecutive declines
 *   totalling at least 0.2.
 * - THEME_EMERGING: mostly-negative themes (≥ 3 mentions) absent last period.
 * - SEGMENT_RISK: segments at HIGH/CRITICAL risk, and accounts the AI risk
 *   assessment rates HIGH/CRITICAL.
 *
 * One candidate per type at most, so alerts dedupe per period and type.
 */
import type { RiskLevel, SentimentAlertType } from "@prisma/client";
import type { SnapshotFigures, ThemeStat } from "./aggregate";

export interface HistoryPoint {
  periodStart: Date;
  overallScore: number;
  volume: number;
  negativeCount: number;
  topThemes: ThemeStat[];
}

export interface AlertCandidate {
  type: SentimentAlertType;
  severity: RiskLevel;
  title: string;
  description: string;
  dataPoints: Record<string, unknown>;
}

export const MIN_HISTORY = 3;
const MIN_VOLUME = 5;
const STD_FLOOR = 0.05;

function meanStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.max(STD_FLOOR, Math.sqrt(variance)) };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function detectAnomalies(input: {
  current: SnapshotFigures;
  history: HistoryPoint[];
  segments: Array<{ segment: string; figures: SnapshotFigures }>;
  highRiskAccounts: Array<{ customerName: string; riskLevel: RiskLevel }>;
}): AlertCandidate[] {
  const { current, history, segments, highRiskAccounts } = input;
  const out: AlertCandidate[] = [];
  const usable = history.filter((h) => h.volume > 0);

  if (usable.length >= MIN_HISTORY && current.volume >= MIN_VOLUME) {
    // Negative spike.
    const negShares = usable.map((h) => h.negativeCount / h.volume);
    const curNeg = current.negativeCount / current.volume;
    const neg = meanStd(negShares);
    const negZ = (curNeg - neg.mean) / neg.std;
    const delta = curNeg - neg.mean;
    if (negZ >= 2 && delta >= 0.15) {
      out.push({
        type: "SPIKE_NEGATIVE",
        severity: delta >= 0.3 ? "CRITICAL" : delta >= 0.2 ? "HIGH" : "MEDIUM",
        title: `Negative feedback spiked to ${pct(curNeg)}`,
        description: `${current.negativeCount} of ${current.volume} feedback items were negative (${pct(curNeg)}), against a recent average of ${pct(neg.mean)} over ${usable.length} periods.`,
        dataPoints: { negativeShare: r2(curNeg), baselineNegativeShare: r2(neg.mean), zScore: r2(negZ), periodsCompared: usable.length },
      });
    }

    // Score decline.
    const scores = usable.map((h) => h.overallScore);
    const s = meanStd(scores);
    const z = (current.overallScore - s.mean) / s.std;
    const [p1, p2] = usable;
    const consecutive = p1 && p2 && current.overallScore < p1.overallScore && p1.overallScore < p2.overallScore;
    const drop = p2 ? p2.overallScore - current.overallScore : 0;
    if (z <= -2 || (consecutive && drop >= 0.2)) {
      out.push({
        type: "TREND_DECLINE",
        severity: z <= -3 || drop >= 0.4 ? "HIGH" : "MEDIUM",
        title: `Sentiment declined to ${current.overallScore.toFixed(2)}`,
        description: consecutive
          ? `Sentiment fell for three consecutive periods, from ${p2.overallScore.toFixed(2)} to ${current.overallScore.toFixed(2)}.`
          : `Sentiment of ${current.overallScore.toFixed(2)} is well below the recent average of ${s.mean.toFixed(2)}.`,
        dataPoints: { score: current.overallScore, baselineScore: r2(s.mean), zScore: r2(z), drop: r2(drop), periodsCompared: usable.length },
      });
    }
  }

  // Emerging negative themes (needs at least one previous period).
  const previous = usable[0];
  if (previous) {
    const seen = new Set(previous.topThemes.map((t) => t.name.toLowerCase()));
    const emerging = current.topThemes.filter((t) => t.count >= 3 && t.negative / t.count >= 0.6 && !seen.has(t.name.toLowerCase()));
    if (emerging.length > 0) {
      const top = emerging.slice(0, 5);
      out.push({
        type: "THEME_EMERGING",
        severity: top.some((t) => t.count >= 10) ? "HIGH" : "MEDIUM",
        title: top.length === 1 ? `New negative theme: ${top[0].name}` : `${top.length} new negative themes`,
        description: `Themes not seen last period, mostly negative: ${top.map((t) => `${t.name} (${t.count} mentions, ${pct(t.negative / t.count)} negative)`).join("; ")}.`,
        dataPoints: { themes: top.map((t) => ({ name: t.name, count: t.count, negative: t.negative })) },
      });
    }
  }

  const riskySegments = segments.filter((s) => s.figures.riskLevel === "HIGH" || s.figures.riskLevel === "CRITICAL");
  if (riskySegments.length > 0 || highRiskAccounts.length > 0) {
    const critical = riskySegments.some((s) => s.figures.riskLevel === "CRITICAL") || highRiskAccounts.some((a) => a.riskLevel === "CRITICAL");
    const parts: string[] = [];
    if (riskySegments.length > 0) {
      parts.push(`Segments at risk: ${riskySegments.map((s) => `${s.segment} (score ${s.figures.overallScore.toFixed(2)}, ${s.figures.volume} items)`).join("; ")}.`);
    }
    if (highRiskAccounts.length > 0) {
      parts.push(`The AI risk assessment rates ${highRiskAccounts.length} account(s) high risk: ${highRiskAccounts.slice(0, 5).map((a) => a.customerName).join(", ")}${highRiskAccounts.length > 5 ? ", …" : ""}.`);
    }
    out.push({
      type: "SEGMENT_RISK",
      severity: critical ? "CRITICAL" : "HIGH",
      title: riskySegments.length > 0 ? `${riskySegments.length} customer segment(s) at risk` : `${highRiskAccounts.length} account(s) at high churn risk`,
      description: parts.join(" "),
      dataPoints: {
        segments: riskySegments.map((s) => ({ segment: s.segment, score: s.figures.overallScore, riskLevel: s.figures.riskLevel, volume: s.figures.volume })),
        highRiskAccounts: highRiskAccounts.slice(0, 20),
      },
    });
  }
  return out;
}
