"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { GapAnalysisResult } from "./gap-analysis-result";

type JobStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";
const RUNNING: JobStatus[] = ["PENDING", "PROCESSING"];

const STATUS_BADGE: Record<JobStatus, { label: string; variant: NonNullable<BadgeProps["variant"]> }> = {
  PENDING: { label: "Queued", variant: "secondary" },
  PROCESSING: { label: "Analyzing", variant: "low" },
  READY: { label: "Ready", variant: "positive" },
  FAILED: { label: "Failed", variant: "destructive" },
};

interface GapAnalysisViewProps {
  projectId: string;
  roadmapId: string;
  itemCount: number;
}

export function GapAnalysisView({ projectId, roadmapId, itemCount }: GapAnalysisViewProps) {
  const utils = trpc.useUtils();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = trpc.roadmap.getGapAnalysis.useQuery(
    { projectId, roadmapId },
    {
      refetchInterval: (q) => {
        const status = q.state.data?.latest?.status;
        return status && RUNNING.includes(status) ? 3000 : false;
      },
    }
  );
  const latest = query.data?.latest ?? null;
  const running = latest ? RUNNING.includes(latest.status) : false;

  // Announce completion when a run we were watching finishes.
  const prevStatus = useRef<JobStatus | null>(null);
  useEffect(() => {
    const status = latest?.status ?? null;
    if (prevStatus.current && RUNNING.includes(prevStatus.current)) {
      if (status === "READY") toast.success("Gap analysis complete");
      else if (status === "FAILED") toast.error("Gap analysis failed");
    }
    prevStatus.current = status;
  }, [latest?.status]);

  useEffect(() => setSelectedId(null), [roadmapId]);

  const run = trpc.roadmap.runGapAnalysis.useMutation({
    onSuccess: async (res) => {
      setSelectedId(null);
      await utils.roadmap.getGapAnalysis.invalidate({ projectId, roadmapId });
      toast.success(res.alreadyRunning ? "A gap analysis is already running" : "Gap analysis started");
    },
  });

  const viewingHistory = selectedId !== null && selectedId !== latest?.id;
  const historical = trpc.roadmap.getGapAnalysisById.useQuery(
    { projectId, gapAnalysisId: selectedId ?? "" },
    { enabled: viewingHistory }
  );
  const shown = viewingHistory ? historical.data : latest;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-lg">Gap analysis</CardTitle>
          <CardDescription>Compares this roadmap with the themes from your latest synthesis.</CardDescription>
        </div>
        <Button onClick={() => run.mutate({ projectId, roadmapId })} disabled={run.isPending || running || itemCount === 0}>
          {running || run.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Zap className="mr-2 h-4 w-4" aria-hidden />}
          {running ? "Analyzing…" : "Run gap analysis"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {query.isLoading ? (
          <LoadingState rows={3} label="Loading gap analysis" />
        ) : query.isError ? (
          <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : !latest ? (
          <EmptyState
            icon={<Zap className="h-8 w-8" />}
            title="No gap analysis yet"
            description={
              itemCount === 0
                ? "Add or import roadmap items first. Gap analysis also needs a completed synthesis."
                : "Run a gap analysis to see which customer themes the roadmap covers, partially covers or misses."
            }
          />
        ) : (
          <>
            {viewingHistory && (
              <div className="flex items-center justify-between rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900">
                <span>Viewing an earlier analysis.</span>
                <Button variant="link" className="h-auto p-0" onClick={() => setSelectedId(null)}>
                  Back to latest
                </Button>
              </div>
            )}
            {viewingHistory && historical.isLoading ? (
              <LoadingState rows={3} label="Loading analysis" />
            ) : viewingHistory && historical.isError ? (
              <ErrorState message={historical.error.message} onRetry={() => void historical.refetch()} />
            ) : shown ? (
              <div aria-live="polite" className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant={STATUS_BADGE[shown.status].variant}>{STATUS_BADGE[shown.status].label}</Badge>
                  <span>Started {new Date(shown.createdAt).toLocaleString()}</span>
                  {shown.completedAt && <span>· finished {new Date(shown.completedAt).toLocaleString()}</span>}
                </div>
                {RUNNING.includes(shown.status) && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Comparing themes with roadmap items. This usually takes under a minute.
                  </p>
                )}
                {shown.status === "FAILED" && (
                  <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
                    <p className="font-medium text-destructive">The analysis failed</p>
                    <p className="mt-1 text-muted-foreground">{shown.errorMessage ?? "Something went wrong. Please try again."}</p>
                  </div>
                )}
                {shown.status === "READY" &&
                  (shown.output ? (
                    <GapAnalysisResult output={shown.output} />
                  ) : (
                    <p className="text-sm text-muted-foreground">This analysis was produced by an older version and can&apos;t be displayed. Run it again.</p>
                  ))}
              </div>
            ) : null}

            {(query.data?.history.length ?? 0) > 1 && (
              <section aria-label="Analysis history" className="space-y-2 border-t pt-4 dark:border-gray-800">
                <h3 className="text-sm font-semibold">History</h3>
                <ul className="space-y-1">
                  {query.data!.history.map((h) => {
                    const active = (selectedId ?? latest.id) === h.id;
                    return (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(h.id === latest.id ? null : h.id)}
                          aria-current={active ? "true" : undefined}
                          className={`flex w-full flex-wrap items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-800 ${active ? "bg-gray-100 dark:bg-gray-800" : ""}`}
                        >
                          <Badge variant={STATUS_BADGE[h.status].variant}>{STATUS_BADGE[h.status].label}</Badge>
                          <span>{new Date(h.createdAt).toLocaleString()}</span>
                          {h.stats && (
                            <span className="text-muted-foreground">
                              · {h.stats.covered} covered, {h.stats.partial} partial, {h.stats.missing} missing
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
