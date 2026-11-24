"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, ChevronDown, ChevronRight, CircleSlash, History, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ACTION_META } from "@/server/workflows/definitions";
import { RunStatusBadge } from "./run-status-badge";

function actionLabel(type: string): string {
  return type in ACTION_META ? ACTION_META[type as keyof typeof ACTION_META].label : type;
}

function duration(start: Date, end: Date | null): string {
  if (!end) return "in progress";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function OutputLinks({ output }: { output: Record<string, unknown> | undefined }) {
  if (!output) return null;
  const entries = Object.entries(output).filter(([k]) => k !== "url");
  const url = typeof output.url === "string" && output.url.startsWith("https://") ? output.url : null;
  if (!entries.length && !url) return null;
  return (
    <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
      {entries.map(([k, v]) => (
        <div key={k} className="flex gap-1">
          <dt>{k}:</dt>
          <dd className="font-mono">{String(v)}</dd>
        </div>
      ))}
      {url && (
        <div>
          <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline dark:text-blue-400">
            Open issue
          </a>
        </div>
      )}
    </dl>
  );
}

export function RunHistory({ workflowId, polling }: { workflowId: string; polling?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const runs = trpc.workflow.runs.useInfiniteQuery(
    { workflowId, limit: 20 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (q) => {
        const items = q.state.data?.pages.flatMap((p) => p.items) ?? [];
        return polling || items.some((r) => r.status === "RUNNING") ? 3000 : false;
      },
    }
  );

  if (runs.isLoading) return <LoadingState rows={3} label="Loading runs" />;
  if (runs.isError) return <ErrorState message={runs.error.message} onRetry={() => void runs.refetch()} />;
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return <EmptyState icon={<History className="h-8 w-8" />} title="No runs yet" description="Runs appear here when the trigger event happens or when you run the workflow manually." />;
  }

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border dark:divide-gray-800 dark:border-gray-800">
        {items.map((run) => {
          const expanded = open.has(run.id);
          return (
            <li key={run.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
                aria-expanded={expanded}
                aria-controls={`run-${run.id}`}
                onClick={() => toggle(run.id)}
              >
                {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                <RunStatusBadge status={run.status} />
                <span className="flex-1 text-sm">
                  {run.trigger}
                  {run.causationDepth > 0 && <span className="text-gray-500"> · chained ×{run.causationDepth}</span>}
                </span>
                <span className="text-xs text-gray-500" title={new Date(run.startedAt).toLocaleString()}>
                  {formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })} · {duration(run.startedAt, run.completedAt)}
                </span>
              </button>
              {expanded && (
                <div id={`run-${run.id}`} className="space-y-2 bg-gray-50 px-4 py-3 dark:bg-gray-900/40">
                  {run.error && <p className="text-sm text-red-700 dark:text-red-300">{run.error}</p>}
                  {run.actions.length === 0 ? (
                    <p className="text-sm text-gray-500">No actions ran.</p>
                  ) : (
                    <ol className="space-y-2">
                      {run.actions.map((a) => (
                        <li key={a.index} className="flex gap-2 text-sm">
                          {a.status === "success" ? (
                            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" aria-label="Succeeded" />
                          ) : a.status === "skipped" ? (
                            <CircleSlash className="mt-0.5 h-4 w-4 flex-shrink-0 text-gray-500" aria-label="Skipped" />
                          ) : (
                            <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" aria-label="Failed" />
                          )}
                          <div>
                            <p>
                              <span className="font-medium">
                                {a.index + 1}. {actionLabel(a.type)}
                              </span>
                              {" — "}
                              {a.message}
                              {typeof a.durationMs === "number" && <span className="text-gray-500"> ({a.durationMs} ms)</span>}
                            </p>
                            <OutputLinks output={a.output} />
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {runs.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
          {runs.isFetchingNextPage ? "Loading…" : "Load more runs"}
        </Button>
      )}
    </div>
  );
}
