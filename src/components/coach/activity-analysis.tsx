"use client";

import { format } from "date-fns";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

/** Facts the coach works from (computed from project data, no AI). */
export function ActivityAnalysis({ projectId }: { projectId: string }) {
  const q = trpc.coach.getActivityAnalysis.useQuery({ projectId });
  if (q.isLoading) return <LoadingState rows={2} label="Loading activity" />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  const a = q.data;
  if (!a) return null;
  const p = a.decisionPatterns;
  const tiles = [
    { label: "Documents (30 days)", value: a.counts.documentsRecent.toLocaleString() },
    { label: "Recommendations (30 days)", value: a.counts.recommendationsRecent.toLocaleString() },
    { label: "Acceptance rate", value: pct(p.acceptanceRate) },
    { label: "Decisions citing evidence", value: pct(p.decisionsWithEvidenceShare) },
    { label: "Drafts older than 14 days", value: a.counts.staleDrafts.toLocaleString() },
    { label: "Shipped without outcome tracking", value: a.counts.acceptedWithoutOutcome.toLocaleString() },
  ];
  const activity = Object.entries(a.activity).sort((x, y) => y[1] - x[1]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Practice snapshot</CardTitle>
        <p className="text-xs text-muted-foreground">
          {a.latestSynthesisAt ? `Latest synthesis ${format(a.latestSynthesisAt, "PP")}` : "No synthesis yet"} · {a.counts.documents.toLocaleString()} documents in total
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-3">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-md border p-3">
              <dt className="text-xs text-muted-foreground">{t.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{t.value}</dd>
            </div>
          ))}
        </dl>
        {p.avgConfidenceAccepted !== null && p.avgConfidenceRejected !== null && (
          <p className="text-sm text-muted-foreground">
            Average confidence of accepted recommendations {p.avgConfidenceAccepted.toFixed(2)} vs rejected {p.avgConfidenceRejected.toFixed(2)}.
          </p>
        )}
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Well-supported themes without a recommendation</h4>
          {a.ignoredThemes.length === 0 ? (
            <p className="text-sm text-muted-foreground">None. Every strong theme has a related recommendation.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {a.ignoredThemes.map((t) => (
                <li key={t.name}>
                  <Badge variant={t.sentiment === "NEGATIVE" ? "negative" : "secondary"}>
                    {t.name} · {t.citationCount} citations
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        {activity.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity, last 14 days</h4>
            <ul className="space-y-1 text-sm">
              {activity.map(([type, n]) => (
                <li key={type} className="flex justify-between">
                  <span>{type.replace(/[._]/g, " ")}</span>
                  <span className="tabular-nums text-muted-foreground">{n}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
