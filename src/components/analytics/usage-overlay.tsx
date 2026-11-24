"use client";

import { useEffect, useMemo, useState } from "react";
import { LineChart as LineChartIcon } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { trpc } from "@/lib/trpc";

const NO_THEME = "__none__";
const seriesValue = (feature: string, metric: string) => JSON.stringify([feature, metric]);

/**
 * Explore one imported metric over time, optionally overlaid with how often a
 * theme was mentioned in customer feedback (daily citation counts).
 */
export function UsageOverlay({ projectId }: { projectId: string }) {
  const series = trpc.analytics.listSeries.useQuery({ projectId });
  // Any theme of the latest synthesis can be overlaid, correlated or not.
  const themeList = trpc.analytics.listThemes.useQuery({ projectId });
  const themes = useMemo(() => (themeList.data ?? []).map((t) => ({ id: t.id, name: t.name })), [themeList.data]);

  const [selected, setSelected] = useState<string | null>(null);
  const [themeId, setThemeId] = useState<string>(NO_THEME);

  useEffect(() => {
    const list = series.data ?? [];
    if (list.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !list.some((s) => seriesValue(s.feature, s.metric) === selected)) {
      setSelected(seriesValue(list[0].feature, list[0].metric));
    }
  }, [series.data, selected]);
  useEffect(() => {
    if (themeId !== NO_THEME && !themes.some((t) => t.id === themeId)) setThemeId(NO_THEME);
  }, [themes, themeId]);

  const [feature, metric] = selected ? (JSON.parse(selected) as [string, string]) : ["", ""];
  const detail = trpc.analytics.getSeries.useQuery(
    { projectId, feature, metric, ...(themeId !== NO_THEME ? { themeId } : {}) },
    { enabled: Boolean(selected) }
  );

  const chartData = useMemo(() => {
    if (!detail.data) return [];
    const byDate = new Map<string, { date: string; value?: number; mentions?: number }>();
    for (const p of detail.data.points) byDate.set(p.date, { date: p.date, value: p.value });
    if (detail.data.mentions) {
      const first = detail.data.points[0]?.date;
      const last = detail.data.points[detail.data.points.length - 1]?.date;
      for (const m of detail.data.mentions) {
        // Only overlay mentions inside the metric's date range.
        if (first && last && (m.date < first || m.date > last)) continue;
        const row = byDate.get(m.date) ?? { date: m.date };
        row.mentions = m.count;
        byDate.set(m.date, row);
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [detail.data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Usage over time</CardTitle>
        <CardDescription>Compare an imported metric with how often customers mention a theme.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {series.isLoading ? (
          <LoadingState rows={2} label="Loading metrics" />
        ) : series.isError ? (
          <ErrorState message={series.error.message} onRetry={() => void series.refetch()} />
        ) : (series.data ?? []).length === 0 ? (
          <EmptyState icon={<LineChartIcon className="h-8 w-8" />} title="No metrics to chart" description="Import usage data to explore it here." />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="usage-series">Metric</Label>
                <Select value={selected ?? undefined} onValueChange={setSelected}>
                  <SelectTrigger id="usage-series">
                    <SelectValue placeholder="Choose a metric" />
                  </SelectTrigger>
                  <SelectContent>
                    {series.data!.map((s) => (
                      <SelectItem key={seriesValue(s.feature, s.metric)} value={seriesValue(s.feature, s.metric)}>
                        {s.feature} · {s.metric} ({s.points} days)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="usage-theme">Overlay theme mentions</Label>
                <Select value={themeId} onValueChange={setThemeId} disabled={themes.length === 0}>
                  <SelectTrigger id="usage-theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_THEME}>{themes.length === 0 ? "Run a synthesis to pick themes" : "No overlay"}</SelectItem>
                    {themes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {detail.isLoading ? (
              <LoadingState rows={1} label="Loading chart" />
            ) : detail.isError ? (
              <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
            ) : chartData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data points for this metric.</p>
            ) : (
              <figure className="space-y-2">
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                      <YAxis yAxisId="metric" tick={{ fontSize: 11 }} width={56} />
                      {detail.data?.mentions && <YAxis yAxisId="mentions" orientation="right" allowDecimals={false} tick={{ fontSize: 11 }} width={40} />}
                      <Tooltip />
                      <Legend />
                      {detail.data?.mentions && (
                        <Bar yAxisId="mentions" dataKey="mentions" name={`Mentions: ${detail.data.theme?.name ?? "theme"}`} fill="#f59e0b" barSize={8} />
                      )}
                      <Line
                        yAxisId="metric"
                        type="monotone"
                        dataKey="value"
                        name={`${detail.data?.feature} · ${detail.data?.metric}`}
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <figcaption className="text-xs text-muted-foreground">
                  {detail.data?.points.length} daily values
                  {detail.data?.mentions ? ` with ${chartData.reduce((sum, r) => sum + (r.mentions ?? 0), 0)} theme mentions in range` : ""}.
                </figcaption>
              </figure>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
