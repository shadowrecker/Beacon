"use client";

import { useId, useState } from "react";
import { BarChart3 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";

const selectClass =
  "flex h-9 rounded-lg border border-gray-300 bg-white px-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3 dark:border-gray-800">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function ApiUsage() {
  const uid = useId();
  const [days, setDays] = useState(30);
  const [keyId, setKeyId] = useState("");
  const keys = trpc.apiKey.list.useQuery({ includeRevoked: true, limit: 100 });
  const usage = trpc.apiKey.getUsage.useQuery({ days, keyId: keyId || undefined });

  return (
    <section aria-labelledby="usage-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="usage-heading" className="text-xl font-semibold">
          Usage
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={`${uid}-key`}>Key</Label>
            <select id={`${uid}-key`} className={selectClass} value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">All keys</option>
              {keys.data?.items.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.prefix}…)
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${uid}-days`}>Period</Label>
            <select id={`${uid}-days`} className={selectClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>Last 24 hours</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
        </div>
      </div>

      {usage.isLoading ? (
        <LoadingState rows={2} label="Loading usage" />
      ) : usage.isError ? (
        <ErrorState message={usage.error.message} onRetry={() => void usage.refetch()} />
      ) : !usage.data || usage.data.totals.requests === 0 ? (
        <EmptyState icon={<BarChart3 className="h-8 w-8" />} title="No API requests in this period" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Requests" value={usage.data.totals.requests.toLocaleString()} />
            <Stat
              label="Error rate"
              value={`${((usage.data.totals.errors / Math.max(1, usage.data.totals.requests)) * 100).toFixed(1)}%`}
            />
            <Stat label="Avg latency" value={usage.data.totals.avgLatencyMs === null ? "–" : `${usage.data.totals.avgLatencyMs} ms`} />
            <Stat label="p95 latency" value={usage.data.totals.p95LatencyMs === null ? "–" : `${usage.data.totals.p95LatencyMs} ms`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By endpoint</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th scope="col" className="pb-2 font-medium">Endpoint</th>
                      <th scope="col" className="pb-2 text-right font-medium">Requests</th>
                      <th scope="col" className="pb-2 text-right font-medium">Errors</th>
                      <th scope="col" className="pb-2 text-right font-medium">Avg ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.data.byEndpoint.map((e) => (
                      <tr key={`${e.method} ${e.endpoint}`} className="border-t dark:border-gray-800">
                        <td className="py-1.5 font-mono text-xs">
                          {e.method} {e.endpoint}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{e.requests.toLocaleString()}</td>
                        <td className="py-1.5 text-right tabular-nums">{e.errors.toLocaleString()}</td>
                        <td className="py-1.5 text-right tabular-nums">{e.avgLatencyMs ?? "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By day</CardTitle>
              </CardHeader>
              <CardContent className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th scope="col" className="pb-2 font-medium">Day (UTC)</th>
                      <th scope="col" className="pb-2 text-right font-medium">Requests</th>
                      <th scope="col" className="pb-2 text-right font-medium">Errors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...usage.data.byDay].reverse().map((d) => (
                      <tr key={d.day} className="border-t dark:border-gray-800">
                        <td className="py-1.5 tabular-nums">{d.day}</td>
                        <td className="py-1.5 text-right tabular-nums">{d.requests.toLocaleString()}</td>
                        <td className="py-1.5 text-right tabular-nums">{d.errors.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-gray-500">
                  Status classes: {usage.data.byStatus.map((s) => `${s.statusClass} ${s.requests.toLocaleString()}`).join(" · ")}
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </section>
  );
}
