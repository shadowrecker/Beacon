"use client";

import { useEffect, useRef, useState } from "react";
import { Lightbulb, Sparkles } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { useJobRun } from "@/components/ui/use-job-run";
import { InsightCard } from "./insight-card";

/**
 * Coaching insights for one project (or across projects when `projectId` is
 * omitted). New insights are marked seen once displayed. "Get coaching" queues
 * an asynchronous run and polls it.
 */
export function CoachPanel({ projectId, canRequest }: { projectId?: string; canRequest?: boolean }) {
  const utils = trpc.useUtils();
  const [view, setView] = useState<"open" | "all">("open");
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const list = trpc.coach.getInsights.useInfiniteQuery({ projectId, view, limit: 10 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  const { mutate: markSeen } = trpc.coach.markSeen.useMutation({ meta: { silent: true } });
  const marked = useRef(new Set<string>());
  const newIds = items.filter((i) => i.status === "NEW").map((i) => i.id).join(",");
  useEffect(() => {
    // Keep the "New" highlight in this view; the bell count updates on its next poll.
    const ids = newIds.split(",").filter((id) => id && !marked.current.has(id)).slice(0, 100);
    if (ids.length === 0) return;
    ids.forEach((id) => marked.current.add(id));
    markSeen({ insightIds: ids });
  }, [newIds, markSeen]);

  const request = trpc.coach.requestCoaching.useMutation({
    onSuccess: (res) => {
      setJobRunId(res.jobRunId);
      toast.info(res.deduplicated ? "Coaching is already being prepared" : "Preparing coaching insights");
    },
  });
  const job = useJobRun(jobRunId, {
    onReady: async (output) => {
      const created = (output as { insightsCreated?: number } | null)?.insightsCreated ?? 0;
      toast.success(created > 0 ? `${created} new insight${created === 1 ? "" : "s"}` : "No new insights right now: your recent coaching still applies");
      setJobRunId(null);
      await Promise.all([utils.coach.getInsights.invalidate(), utils.coach.getCoachingHistory.invalidate()]);
    },
    onFailed: (message) => {
      toast.error(`Coaching failed: ${message}`);
      setJobRunId(null);
    },
  });
  const running = request.isPending || job.isRunning;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Insights to show">
          <Button size="sm" variant={view === "open" ? "default" : "outline"} aria-pressed={view === "open"} onClick={() => setView("open")}>
            Open
          </Button>
          <Button size="sm" variant={view === "all" ? "default" : "outline"} aria-pressed={view === "all"} onClick={() => setView("all")}>
            All
          </Button>
        </div>
        {projectId && canRequest && (
          <Button disabled={running} onClick={() => request.mutate({ projectId })}>
            <Sparkles className={`mr-2 h-4 w-4 ${running ? "animate-pulse" : ""}`} aria-hidden />
            {running ? "Preparing coaching…" : "Get coaching"}
          </Button>
        )}
      </div>
      {running && (
        <p role="status" className="text-sm text-muted-foreground">
          The coach is reviewing this project&apos;s recent activity. Insights appear here when ready.
        </p>
      )}
      {list.isLoading ? (
        <LoadingState rows={3} label="Loading insights" />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Lightbulb className="h-8 w-8" />}
          title={view === "open" ? "No open insights" : "No insights yet"}
          description={projectId ? "The coach reviews project activity automatically. You can also ask for coaching now." : "Pick a project to get coaching on it."}
        />
      ) : (
        <ul className="space-y-3">
          {items.map((i) => (
            <li key={i.id}>
              <InsightCard insight={i} showProject={!projectId} />
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button variant="outline" className="w-full" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  );
}
