/**
 * Outcome status labels and shared types for the outcomes UI.
 */
import type { RouterOutputs } from "@/lib/trpc";

export type OutcomeItem = RouterOutputs["outcome"]["getOutcomes"]["items"][number];
export type OutcomeStatus = OutcomeItem["status"];
export type DecisionItem = RouterOutputs["outcome"]["getDecisionLog"]["items"][number];
export type Learnings = RouterOutputs["outcome"]["getLearnings"];

export const OUTCOME_STATUS_OPTIONS: Array<{ value: OutcomeStatus; label: string; description: string }> = [
  { value: "NOT_SHIPPED", label: "Not shipped", description: "Accepted but not released yet" },
  { value: "SHIPPED", label: "Shipped", description: "Released; measurement not started" },
  { value: "MEASURING", label: "Measuring", description: "Collecting data against the target" },
  { value: "MEASURED", label: "Measured", description: "Final result recorded" },
];

export function outcomeStatusLabel(s: OutcomeStatus): string {
  return OUTCOME_STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s;
}

export function outcomeStatusVariant(s: OutcomeStatus): "secondary" | "low" | "medium" | "positive" {
  return s === "NOT_SHIPPED" ? "secondary" : s === "SHIPPED" ? "low" : s === "MEASURING" ? "medium" : "positive";
}

export function impactVariant(i: "HIGH" | "MEDIUM" | "LOW"): "high" | "medium" | "low" {
  return i === "HIGH" ? "high" : i === "MEDIUM" ? "medium" : "low";
}

export function formatValue(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(Math.round(v * 1000) / 1000);
}

export function formatPercent(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}
