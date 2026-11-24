"use client";

import { format } from "date-fns";
import { History } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";

const TRIGGER_LABELS: Record<string, string> = { manual: "Requested", event: "After project activity", digest: "Weekday digest" };

/** Past coaching runs for the caller (one project, or all). */
export function CoachingHistory({ projectId }: { projectId?: string }) {
  const list = trpc.coach.getCoachingHistory.useInfiniteQuery({ projectId, limit: 10 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  if (list.isLoading) return <LoadingState rows={3} label="Loading coaching history" />;
  if (list.isError) return <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />;
  if (items.length === 0) return <EmptyState icon={<History className="h-8 w-8" />} title="No coaching sessions yet" />;

  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {items.map((s) => (
          <li key={s.id} className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{format(s.createdAt, "PPp")}</span>
              <span className="text-xs text-muted-foreground">
                {TRIGGER_LABELS[s.trigger ?? ""] ?? "Coaching"}
                {!projectId && ` · ${s.project.name}`}
              </span>
            </div>
            {s.summary && <p className="mt-2 text-muted-foreground">{s.summary}</p>}
            {s.insights.length > 0 ? (
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                {s.insights.map((i, k) => (
                  <li key={`${s.id}-${k}`}>{i.title}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">No new insights (recent advice still applied).</p>
            )}
          </li>
        ))}
      </ol>
      {list.hasNextPage && (
        <Button variant="outline" className="w-full" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  );
}
