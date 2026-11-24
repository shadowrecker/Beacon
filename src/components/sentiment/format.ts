/** Shared display helpers for sentiment figures. */
export type Period = "DAILY" | "WEEKLY" | "MONTHLY";
export type Risk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const PERIOD_LABELS: Record<Period, string> = { DAILY: "Daily", WEEKLY: "Weekly", MONTHLY: "Monthly" };

export function riskBadgeVariant(risk: string): "low" | "medium" | "high" | "destructive" {
  if (risk === "CRITICAL") return "destructive";
  if (risk === "HIGH") return "high";
  if (risk === "MEDIUM") return "medium";
  return "low";
}

export function riskLabel(risk: string): string {
  return risk.charAt(0) + risk.slice(1).toLowerCase();
}

export function scoreLabel(score: number): string {
  if (score >= 0.3) return "Positive";
  if (score <= -0.3) return "Negative";
  return "Mixed";
}

export function formatScore(score: number): string {
  return `${score > 0 ? "+" : ""}${score.toFixed(2)}`;
}

/** Inclusive date range label for a period window stored as [start, end). */
export function periodRange(start: Date, end: Date, period: string): string {
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (period === "DAILY") return fmt(start);
  return `${fmt(start)} – ${fmt(new Date(end.getTime() - 86_400_000))}`;
}
