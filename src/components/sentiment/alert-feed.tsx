"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { BellRing, Check, CheckCheck } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { riskBadgeVariant, riskLabel } from "./format";

type StatusFilter = "OPEN" | "NEW" | "ACKNOWLEDGED" | "RESOLVED" | "ALL";

const TYPE_LABELS: Record<string, string> = {
  TREND_DECLINE: "Declining trend",
  SPIKE_NEGATIVE: "Negative spike",
  THEME_EMERGING: "Emerging theme",
  SEGMENT_RISK: "Segment risk",
};

/** Sentiment alerts with acknowledge / resolve actions. */
export function AlertFeed({ projectId, canWrite }: { projectId: string; canWrite: boolean }) {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<StatusFilter>("OPEN");
  const status = filter === "OPEN" || filter === "ALL" ? undefined : filter;
  const list = trpc.sentiment.getAlerts.useInfiniteQuery({ projectId, status, limit: 20 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const refresh = () => Promise.all([utils.sentiment.getAlerts.invalidate({ projectId }), utils.sentiment.getCurrentSentiment.invalidate({ projectId })]);
  const ack = trpc.sentiment.acknowledgeAlert.useMutation({ onSuccess: async () => { toast.success("Alert acknowledged"); await refresh(); } });
  const resolve = trpc.sentiment.resolveAlert.useMutation({ onSuccess: async () => { toast.success("Alert resolved"); await refresh(); } });
  const all = list.data?.pages.flatMap((p) => p.items) ?? [];
  const items = filter === "OPEN" ? all.filter((a) => a.status !== "RESOLVED") : all;
  const busy = ack.isPending || resolve.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Alerts</CardTitle>
        <div className="w-44 space-y-1">
          <Label htmlFor="alert-status" className="text-xs">
            Show
          </Label>
          <Select value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
            <SelectTrigger id="alert-status" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OPEN">Open</SelectItem>
              <SelectItem value="NEW">New</SelectItem>
              <SelectItem value="ACKNOWLEDGED">Acknowledged</SelectItem>
              <SelectItem value="RESOLVED">Resolved</SelectItem>
              <SelectItem value="ALL">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {list.isLoading ? (
          <LoadingState rows={3} label="Loading alerts" />
        ) : list.isError ? (
          <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon={<BellRing className="h-8 w-8" />} title="No alerts" description="Alerts are raised when sentiment drops sharply, negative feedback spikes, a new negative theme emerges, or a segment is at risk." />
        ) : (
          <ul className="space-y-3">
            {items.map((a) => (
              <li key={a.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={riskBadgeVariant(a.severity)}>{riskLabel(a.severity)}</Badge>
                  <span className="text-xs text-muted-foreground">{TYPE_LABELS[a.type] ?? a.type}</span>
                  <span className="text-xs text-muted-foreground">· {formatDistanceToNow(a.createdAt, { addSuffix: true })}</span>
                  {a.status !== "NEW" && (
                    <Badge variant="outline" className="ml-auto">
                      {a.status === "RESOLVED" ? "Resolved" : "Acknowledged"}
                    </Badge>
                  )}
                </div>
                <p className="mt-2 font-medium">{a.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{a.description}</p>
                {canWrite && a.status !== "RESOLVED" && (
                  <div className="mt-3 flex gap-2">
                    {a.status === "NEW" && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => ack.mutate({ projectId, alertId: a.id })}>
                        <Check className="mr-1.5 h-4 w-4" aria-hidden />
                        Acknowledge
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve.mutate({ projectId, alertId: a.id })}>
                      <CheckCheck className="mr-1.5 h-4 w-4" aria-hidden />
                      Resolve
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && (
          <Button variant="outline" className="mt-3 w-full" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
