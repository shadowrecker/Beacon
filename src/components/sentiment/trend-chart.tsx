"use client";

import { useMemo } from "react";
import { LineChart as LineIcon } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { formatScore, PERIOD_LABELS, type Period } from "./format";

function axisDate(d: Date, period: Period): string {
  return d.toLocaleDateString(undefined, period === "MONTHLY" ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Sentiment score (line, −1..1) and feedback volume (bars) over recent periods. */
export function TrendChart({ projectId, period }: { projectId: string; period: Period }) {
  const q = trpc.sentiment.getSnapshots.useQuery({ projectId, period, limit: period === "DAILY" ? 60 : period === "WEEKLY" ? 26 : 12 });
  const data = useMemo(
    () =>
      [...(q.data?.items ?? [])].reverse().map((s) => ({
        label: axisDate(s.periodStart, period),
        score: s.overallScore,
        volume: s.volume,
        negative: s.negativeCount,
      })),
    [q.data, period]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{PERIOD_LABELS[period]} trend</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <LoadingState rows={2} label="Loading trend" />
        ) : q.isError ? (
          <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
        ) : data.length === 0 ? (
          <EmptyState icon={<LineIcon className="h-8 w-8" />} title="No snapshots yet" description="The trend fills in as periods are analyzed." />
        ) : (
          <>
            <div className="h-72 w-full" role="img" aria-label={`Sentiment trend over ${data.length} periods, latest score ${formatScore(data[data.length - 1].score)}`}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} stroke="currentColor" strokeOpacity={0.4} />
                  <YAxis yAxisId="score" domain={[-1, 1]} ticks={[-1, -0.5, 0, 0.5, 1]} tick={{ fontSize: 12 }} stroke="currentColor" strokeOpacity={0.4} />
                  <YAxis yAxisId="volume" orientation="right" allowDecimals={false} tick={{ fontSize: 12 }} stroke="currentColor" strokeOpacity={0.4} />
                  <Tooltip
                    formatter={(value, name) => {
                      const n = typeof value === "number" ? value : Number(value);
                      return name === "Score" ? [formatScore(n), name] : [n.toLocaleString(), name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="volume" dataKey="volume" name="Feedback items" fill="#94a3b8" fillOpacity={0.45} radius={[3, 3, 0, 0]} />
                  <Line yAxisId="score" type="monotone" dataKey="score" name="Score" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <table className="sr-only">
              <caption>Sentiment by period</caption>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Score</th>
                  <th scope="col">Feedback items</th>
                  <th scope="col">Negative</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => (
                  <tr key={d.label}>
                    <td>{d.label}</td>
                    <td>{formatScore(d.score)}</td>
                    <td>{d.volume}</td>
                    <td>{d.negative}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
