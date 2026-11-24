"use client";

import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { formatScore, periodRange, riskBadgeVariant, riskLabel, type Period } from "./format";

/** Per-segment sentiment for the most recent analyzed period (segments come from document metadata). */
export function SegmentBreakdown({ projectId, period }: { projectId: string; period: Period }) {
  const q = trpc.sentiment.getSegmentBreakdown.useQuery({ projectId, period });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Segments</CardTitle>
        {q.data?.periodStart && q.data.periodEnd && <p className="text-xs text-muted-foreground">{periodRange(q.data.periodStart, q.data.periodEnd, period)}</p>}
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <LoadingState rows={2} label="Loading segments" />
        ) : q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : !q.data || q.data.segments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No segment data. Segments appear when documents carry a customer segment or plan (for example from integrations) and a segment has at least three feedback items in the period.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="pb-2 font-medium">Segment</th>
                <th scope="col" className="pb-2 font-medium">Score</th>
                <th scope="col" className="pb-2 font-medium">Items</th>
                <th scope="col" className="pb-2 font-medium">Negative</th>
                <th scope="col" className="pb-2 font-medium">Risk</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...(q.data.overall ? [{ ...q.data.overall, segment: "All customers" }] : []), ...q.data.segments].map((s) => (
                <tr key={s.segment}>
                  <th scope="row" className="py-2 text-left font-medium capitalize">{s.segment}</th>
                  <td className="py-2 tabular-nums">{formatScore(s.overallScore)}</td>
                  <td className="py-2 tabular-nums">{s.volume}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-16 overflow-hidden rounded bg-muted" aria-hidden>
                        <div className="h-full bg-red-500" style={{ width: `${s.negativePercent}%` }} />
                      </div>
                      <span className="tabular-nums">{s.negativePercent}%</span>
                    </div>
                  </td>
                  <td className="py-2">
                    <Badge variant={riskBadgeVariant(s.riskLevel)}>{riskLabel(s.riskLevel)}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
