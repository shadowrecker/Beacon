"use client";

/**
 * Synthesis page body: start a run, follow its progress (polling stops on READY
 * or FAILED), pick a past run, and read its themes.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { StatusBadge, isTerminal } from "@/components/documents/status-badge";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { SYNTHESIS_TYPES, SYNTHESIS_TYPE_LABEL, type SynthesisTypeValue } from "./synthesis-types";
import { SynthesisResults } from "./synthesis-results";

const POLL_MS = 2_000;

export function SynthesisWorkspace({ projectId, canRun, readyDocuments }: { projectId: string; canRun: boolean; readyDocuments: number }) {
  const typeId = useId();
  const utils = trpc.useUtils();
  const [type, setType] = useState<SynthesisTypeValue>("FULL");
  const [selected, setSelected] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const runs = trpc.synthesis.list.useInfiniteQuery({ projectId, limit: 10 }, { getNextPageParam: (last) => last.nextCursor });
  const items = useMemo(() => runs.data?.pages.flatMap((p) => p.items) ?? [], [runs.data]);

  // Follow a run that is already in progress when the page opens.
  useEffect(() => {
    if (!activeId) {
      const running = items.find((r) => !isTerminal(r.status));
      if (running) setActiveId(running.id);
    }
  }, [items, activeId]);

  const status = trpc.synthesis.getStatus.useQuery(
    { projectId, id: activeId ?? "" },
    { enabled: Boolean(activeId), refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : POLL_MS) }
  );

  useEffect(() => {
    const s = status.data;
    if (!s || !activeId || s.id !== activeId || !isTerminal(s.status)) return;
    setActiveId(null);
    void Promise.all([
      utils.synthesis.list.invalidate({ projectId }),
      utils.synthesis.getById.invalidate({ projectId, id: s.id }),
      utils.project.getById.invalidate({ id: projectId }),
    ]);
    if (s.status === "READY") {
      toast.success("Synthesis complete");
      setSelected(s.id);
    } else {
      toast.error(s.errorMessage ?? "The synthesis failed");
    }
  }, [status.data, activeId, projectId, utils]);

  const run = trpc.synthesis.run.useMutation({
    onSuccess: async (res) => {
      setActiveId(res.id);
      await utils.synthesis.list.invalidate({ projectId });
      toast.success(res.alreadyRunning ? "A synthesis is already running; following it" : "Synthesis started");
    },
  });

  const fallback = items.find((r) => r.status === "READY")?.id ?? items[0]?.id ?? null;
  const shown = selected ?? fallback;
  const running = Boolean(activeId) || run.isPending;

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <aside className="space-y-4">
        <Card className="space-y-3 p-4">
          <h3 className="font-semibold">Run a synthesis</h3>
          <div className="space-y-1">
            <Label htmlFor={typeId}>Focus</Label>
            <select
              id={typeId}
              value={type}
              onChange={(e) => setType(e.target.value as SynthesisTypeValue)}
              disabled={!canRun || running}
              className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            >
              {SYNTHESIS_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{SYNTHESIS_TYPES.find((t) => t.value === type)?.description}</p>
          </div>
          <Button className="w-full" onClick={() => run.mutate({ projectId, type })} disabled={!canRun || running || readyDocuments === 0}>
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-2 h-4 w-4" aria-hidden />}
            {running ? "Synthesizing…" : "Run synthesis"}
          </Button>
          {!canRun && <p className="text-xs text-muted-foreground">Your role can view syntheses but not run them.</p>}
          {canRun && readyDocuments === 0 && <p className="text-xs text-muted-foreground">Add documents and wait for them to finish processing first.</p>}
          {activeId && (
            <p role="status" className="text-xs text-muted-foreground">
              Analyzing each document, then grouping insights into themes. This can take a few minutes for large projects.
            </p>
          )}
        </Card>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold">History</h3>
          {runs.isLoading ? (
            <LoadingState rows={2} label="Loading runs" />
          ) : runs.isError ? (
            <ErrorState message={runs.error.message} onRetry={() => void runs.refetch()} />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No syntheses yet.</p>
          ) : (
            <ul className="space-y-1" aria-label="Synthesis runs">
              {items.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(r.id)}
                    aria-current={shown === r.id ? "true" : undefined}
                    className={cn(
                      "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-900",
                      shown === r.id && "border-blue-500 bg-blue-50/60 dark:bg-blue-950/20"
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium">{SYNTHESIS_TYPE_LABEL[r.type]}</span>
                      <StatusBadge status={r.status} />
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                      {r.status === "READY" ? ` · ${r.themeCount} themes` : ""}
                      {r.skippedCount ? ` · ${r.skippedCount} skipped` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {runs.hasNextPage && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
              {runs.isFetchingNextPage ? "Loading…" : "Load older runs"}
            </Button>
          )}
        </div>
      </aside>

      <section aria-label="Synthesis results">
        {shown ? (
          <SynthesisResults key={shown} projectId={projectId} synthesisId={shown} />
        ) : runs.isLoading ? null : (
          <EmptyState
            icon={<Sparkles className="h-8 w-8" />}
            title="No synthesis yet"
            description="A synthesis reads every processed document, extracts customer insights and groups them into themes with supporting quotes."
          />
        )}
      </section>
    </div>
  );
}
