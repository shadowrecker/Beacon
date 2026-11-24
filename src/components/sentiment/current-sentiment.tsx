"use client";

import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { formatScore, periodRange, riskBadgeVariant, riskLabel, scoreLabel, type Period } from "./format";

/** Latest project-wide snapshot for the chosen period, with change vs the previous one. */
export function CurrentSentiment({ projectId, period }: { projectId: string; period: Period }) {
  const q = trpc.sentiment.getCurrentSentiment.useQuery({ projectId, period });
  if (q.isLoading) return <LoadingState rows={1} label="Loading current sentiment" />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  const data = q.data;
  if (!data?.current) {
    return <EmptyState title="No sentiment data for this period yet" description="Snapshots are created automatically each day, week and month from new feedback, or run an analysis now." />;
  }
  const c = data.current;
  const delta = data.previous ? c.overallScore - data.previous.overallScore : null;
  const pct = (n: number) => (c.volume > 0 ? Math.round((n / c.volume) * 100) : 0);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Current sentiment · {periodRange(c.periodStart, c.periodEnd, c.period)}</CardTitle>
        <Badge variant={riskBadgeVariant(c.riskLevel)}>{riskLabel(c.riskLevel)} risk</Badge>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <div>
            <dt className="text-xs text-muted-foreground">Score (−1 to +1)</dt>
            <dd className="text-2xl font-semibold tabular-nums">{formatScore(c.overallScore)}</dd>
            <dd className="text-xs text-muted-foreground">{scoreLabel(c.overallScore)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Change vs previous</dt>
            <dd className="flex items-center gap-1 text-2xl font-semibold tabular-nums">
              {delta === null ? (
                "—"
              ) : (
                <>
                  {delta >= 0 ? <TrendingUp className="h-5 w-5 text-green-600" aria-hidden /> : <TrendingDown className="h-5 w-5 text-red-600" aria-hidden />}
                  {formatScore(delta)}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Feedback items</dt>
            <dd className="text-2xl font-semibold tabular-nums">{c.volume.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Positive / neutral / negative</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {pct(c.positiveCount)}% / {pct(c.neutralCount)}% / {pct(c.negativeCount)}%
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Open alerts</dt>
            <dd className="flex items-center gap-1 text-2xl font-semibold tabular-nums">
              {data.openAlerts > 0 && <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />}
              {data.openAlerts}
            </dd>
          </div>
        </dl>
        {c.topThemes.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Top themes</h4>
            <ul className="flex flex-wrap gap-2">
              {c.topThemes.map((t) => (
                <li key={t.name}>
                  <Badge variant={t.averageScore <= -0.3 ? "negative" : t.averageScore >= 0.3 ? "positive" : "neutral"}>
                    {t.name} · {t.count}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.lastRun?.sampledChunks != null && data.lastRun.totalChunks != null && data.lastRun.sampledChunks < data.lastRun.totalChunks && (
          <p className="mt-3 text-xs text-muted-foreground">
            The last manual analysis sampled {data.lastRun.sampledChunks.toLocaleString()} of {data.lastRun.totalChunks.toLocaleString()} feedback passages.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
