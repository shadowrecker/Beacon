"use client";

import { format } from "date-fns";
import type { RouterOutputs } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { riskBadgeVariant, riskLabel } from "./format";

export type Assessment = RouterOutputs["sentiment"]["getChurnPredictions"]["items"][number];

/** Detail of one account's AI risk assessment: the signals behind it and suggested actions. */
export function PredictionCard({ assessment }: { assessment: Assessment }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={riskBadgeVariant(assessment.riskLevel)}>{riskLabel(assessment.riskLevel)} risk</Badge>
        <span className="text-muted-foreground">
          AI risk score {Math.round(assessment.churnProbability * 100)}/100 · confidence {Math.round(assessment.confidence * 100)}%
        </span>
        <span className="text-xs text-muted-foreground">· assessed {format(assessment.createdAt, "PP")}</span>
      </div>
      <div>
        <h5 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Signals</h5>
        <ul className="space-y-1.5">
          {assessment.signals.map((s, i) => (
            <li key={`${s.label}-${i}`} className="flex gap-2">
              <Badge variant={s.weight === "HIGH" ? "high" : s.weight === "MEDIUM" ? "medium" : "outline"} className="h-fit flex-shrink-0">
                {s.source === "computed" ? "Measured" : "AI"}
              </Badge>
              <span>
                <span className="font-medium">{s.label}</span>
                {s.detail && (
                  <>
                    {": "}
                    {s.source === "ai" ? <q className="italic text-muted-foreground">{s.detail}</q> : <span className="text-muted-foreground">{s.detail}</span>}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {assessment.recommendations.length > 0 && (
        <div>
          <h5 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Suggested actions</h5>
          <ul className="list-disc space-y-1 pl-5">
            {assessment.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Methodology: AI risk assessment. A language model judged this account&apos;s feedback against the measured signals above; it is not a statistical churn prediction.
      </p>
    </div>
  );
}
