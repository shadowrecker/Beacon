"use client";

import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import type { SyncRow } from "./types";

type SyncStatus = SyncRow["status"];

const STATUS: Record<SyncStatus, { label: string; variant: "positive" | "negative" | "neutral" | "low"; Icon: typeof CheckCircle2 }> = {
  COMPLETED: { label: "Completed", variant: "positive", Icon: CheckCircle2 },
  FAILED: { label: "Failed", variant: "negative", Icon: XCircle },
  RUNNING: { label: "Syncing", variant: "low", Icon: Loader2 },
  PENDING: { label: "Queued", variant: "neutral", Icon: Clock },
};

export function SyncStatusBadge({ status }: { status: SyncStatus }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant} className="gap-1">
      <s.Icon className={`h-3 w-3 ${status === "RUNNING" ? "animate-spin" : ""}`} aria-hidden />
      {s.label}
    </Badge>
  );
}

export function isSyncActive(status: SyncStatus | undefined | null): boolean {
  return status === "PENDING" || status === "RUNNING";
}

function duration(row: SyncRow): string | null {
  if (!row.completedAt) return null;
  const ms = new Date(row.completedAt).getTime() - new Date(row.startedAt).getTime();
  if (ms < 1000) return "under a second";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
}

function HistoryList({ integrationId }: { integrationId: string }) {
  const history = trpc.integration.syncHistory.useInfiniteQuery(
    { integrationId, limit: 10 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (q) => (q.state.data?.pages[0]?.items.some((r) => isSyncActive(r.status)) ? 5000 : false),
    }
  );
  if (history.isLoading) return <LoadingState rows={3} label="Loading sync history" />;
  if (history.isError) return <ErrorState message={history.error.message} onRetry={() => void history.refetch()} />;
  const rows = history.data?.pages.flatMap((p) => p.items) ?? [];
  if (rows.length === 0) return <EmptyState title="No syncs yet" description="Syncs run automatically on the schedule, or when you click Sync now." />;
  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-md border">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <SyncStatusBadge status={r.status} />
                <span className="text-muted-foreground">
                  <time dateTime={new Date(r.startedAt).toISOString()}>{formatDistanceToNow(new Date(r.startedAt), { addSuffix: true })}</time>
                  {duration(r) ? ` · took ${duration(r)}` : ""}
                </span>
              </div>
              {r.errorMessage && <p className="break-words text-destructive">{r.errorMessage}</p>}
            </div>
            <span className="flex-shrink-0 text-muted-foreground">
              {r.recordsProcessed.toLocaleString()} record{r.recordsProcessed === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
      {history.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            {history.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function SyncHistoryDialog({ integrationId, name, open, onOpenChange }: { integrationId: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{name} sync history</DialogTitle>
          <DialogDescription>Each sync fetches records changed since the previous one.</DialogDescription>
        </DialogHeader>
        {open && <HistoryList integrationId={integrationId} />}
      </DialogContent>
    </Dialog>
  );
}
