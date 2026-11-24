"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Mic, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { isProcessing, RecordingStatusBadge } from "./status";
import { formatDuration } from "./upload";

/**
 * Recordings in the active workspace (optionally one project, or only mine).
 * Polls only while a recording is still processing.
 */
export function RecordingList({
  projectId,
  mine,
  limit = 20,
  showDelete,
  emptyAction,
}: {
  projectId?: string;
  mine?: boolean;
  limit?: number;
  showDelete?: boolean;
  emptyAction?: ReactNode;
}) {
  const utils = trpc.useUtils();
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const list = trpc.voice.list.useInfiniteQuery(
    { projectId, mine: mine ?? false, limit },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some((r) => isProcessing(r.status))) ? 4000 : false),
    }
  );
  const remove = trpc.voice.deleteRecording.useMutation({
    onSuccess: async () => {
      setPendingDelete(null);
      toast.success("Recording deleted");
      await Promise.all([utils.voice.list.invalidate(), utils.voice.getInsights.invalidate()]);
    },
  });

  if (list.isLoading) return <LoadingState rows={3} label="Loading recordings" />;
  if (list.isError) return <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return <EmptyState icon={<Mic className="h-8 w-8" />} title="No recordings yet" description="Record a customer conversation or a voice note to get a transcript and insights." action={emptyAction} />;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border">
        {items.map((r) => {
          const title = r.title || `Recording ${format(new Date(r.recordedAt), "PP p")}`;
          return (
            <li key={r.id} className="flex items-start gap-3 p-3">
              <Link href={`/m/recordings/${r.id}`} className="min-w-0 flex-1 space-y-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{title}</span>
                  <RecordingStatusBadge status={r.status} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {format(new Date(r.recordedAt), "PP p")} · {formatDuration(r.duration)}
                  {r.project ? ` · ${r.project.name}` : ""}
                </p>
                {r.insight?.summary && <p className="line-clamp-2 text-sm text-muted-foreground">{r.insight.summary}</p>}
                {r.status === "FAILED" && r.errorMessage && <p className="text-xs text-destructive">{r.errorMessage}</p>}
              </Link>
              {showDelete && r.isMine && (
                <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" aria-label={`Delete ${title}`} onClick={() => setPendingDelete({ id: r.id, title })}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      <Dialog open={!!pendingDelete} onOpenChange={(o) => !o && !remove.isPending && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this recording?</DialogTitle>
            <DialogDescription>
              {pendingDelete ? `"${pendingDelete.title}"` : "The recording"}, its audio, transcript, insights and transcript document are permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => pendingDelete && remove.mutate({ id: pendingDelete.id })} disabled={remove.isPending}>
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
