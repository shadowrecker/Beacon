"use client";

/**
 * One tracked outcome: recommendation, status, metric values and progress
 * from baseline toward target, with update and engineering-export actions.
 */
import { format } from "date-fns";
import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ExportDialog } from "@/components/handoff/export-dialog";
import { formatPercent, formatValue, impactVariant, outcomeStatusLabel, outcomeStatusVariant, type OutcomeItem } from "./labels";
import { OutcomeFormDialog } from "./outcome-form-dialog";

function progressText(o: OutcomeItem): string {
  if (o.progress === null) {
    return o.baselineValue === null || o.targetValue === null || o.currentValue === null
      ? "Record a baseline, current and target value to see progress."
      : "Progress can't be computed for these values.";
  }
  if (o.progress >= 1) return `Target met (${formatPercent(o.progress)} of the way from baseline).`;
  if (o.progress < 0) return `Moved away from the target (${formatPercent(o.progress)}).`;
  return `${formatPercent(o.progress)} of the way from baseline to target.`;
}

export function OutcomeCard({ projectId, outcome: o }: { projectId: string; outcome: OutcomeItem }) {
  const pct = o.progress === null ? null : Math.max(0, Math.min(100, Math.round(o.progress * 100)));
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0 pb-3">
        <div className="min-w-0 space-y-2">
          <CardTitle className="text-base leading-snug">{o.recommendation.title}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={outcomeStatusVariant(o.status)}>{outcomeStatusLabel(o.status)}</Badge>
            <Badge variant={impactVariant(o.recommendation.impact)}>{o.recommendation.impact} impact</Badge>
            {o.shippedAt && <span className="text-xs text-muted-foreground">Shipped {format(new Date(o.shippedAt), "PP")}</span>}
          </div>
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <OutcomeFormDialog
            projectId={projectId}
            outcome={o}
            trigger={
              <Button variant="outline" size="sm" className="gap-2">
                <Pencil className="h-4 w-4" aria-hidden />
                Update
              </Button>
            }
          />
          <ExportDialog projectId={projectId} recommendationId={o.recommendation.id} recommendationTitle={o.recommendation.title} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium">{o.metricName ?? <span className="text-muted-foreground">No metric chosen yet</span>}</p>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Baseline</dt>
              <dd className="font-medium">{formatValue(o.baselineValue)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Current</dt>
              <dd className="font-medium">{formatValue(o.currentValue)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Target</dt>
              <dd className="font-medium">{formatValue(o.targetValue)}</dd>
            </div>
          </dl>
        </div>
        <div className="space-y-1">
          {pct !== null && <Progress value={pct} aria-label={`Progress toward target: ${pct}%`} />}
          <p className={o.progress !== null && o.progress < 0 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{progressText(o)}</p>
        </div>
        {o.notes && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{o.notes}</p>}
      </CardContent>
    </Card>
  );
}
