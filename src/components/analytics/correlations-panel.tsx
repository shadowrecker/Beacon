"use client";

import { useEffect, useRef, useState } from "react";
import { GitCompareArrows, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { CorrelationCard } from "./correlation-card";

type Filter = "all" | "positive" | "negative";
const RUNNING = ["PENDING", "PROCESSING"];

interface RunSummary {
  correlations?: number;
  strong?: number;
  pairsEvaluated?: number;
  pairsWithEnoughData?: number;
  unit?: string;
}

export function CorrelationsPanel({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const [filter, setFilter] = useState<Filter>("all");
  const [jobRunId, setJobRunId] = useState<string | null>(null);

  // Resume polling a run started earlier (e.g. before a reload).
  const latestRun = trpc.analytics.latestRun.useQuery({ projectId });
  useEffect(() => {
    if (!jobRunId && latestRun.data) setJobRunId(latestRun.data.id);
  }, [latestRun.data, jobRunId]);

  const job = trpc.job.get.useQuery(
    { id: jobRunId ?? "" },
    {
      enabled: Boolean(jobRunId),
      refetchInterval: (q) => (q.state.data && RUNNING.includes(q.state.data.status) ? 3000 : false),
    }
  );
  const status = job.data?.status ?? null;
  const running = status !== null && RUNNING.includes(status);

  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (prev.current && RUNNING.includes(prev.current)) {
      if (status === "READY") {
        const out = (job.data?.output ?? {}) as RunSummary;
        toast.success(`Correlation complete: ${out.correlations ?? 0} correlations found`);
        void utils.analytics.getCorrelations.invalidate({ projectId });
        void utils.analytics.latestRun.invalidate({ projectId });
      } else if (status === "FAILED") {
        toast.error("Correlation analysis failed");
      }
    }
    prev.current = status;
  }, [status, job.data?.output, projectId, utils]);

  const run = trpc.analytics.runCorrelation.useMutation({
    onSuccess: (res) => {
      setJobRunId(res.jobRunId);
      prev.current = res.status;
      void utils.job.get.invalidate({ id: res.jobRunId });
      toast.success(res.alreadyRunning ? "A correlation analysis is already running" : "Correlation analysis started");
    },
  });

  const list = trpc.analytics.getCorrelations.useInfiniteQuery(
    { projectId, limit: 20, ...(filter === "all" ? {} : { direction: filter }) },
    { getNextPageParam: (p) => p.nextCursor ?? undefined }
  );
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const summary = status === "READY" ? ((job.data?.output ?? {}) as RunSummary) : null;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-lg">Theme ↔ usage correlations</CardTitle>
          <CardDescription>
            Pearson correlation between how often a theme appears in feedback and each imported metric. Correlation does not imply causation.
          </CardDescription>
        </div>
        <Button onClick={() => run.mutate({ projectId })} disabled={run.isPending || running}>
          {running || run.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Play className="mr-2 h-4 w-4" aria-hidden />}
          {running ? "Analyzing…" : "Run correlation"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div aria-live="polite" className="space-y-2">
          {running && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Computing correlations across themes and metrics…
            </p>
          )}
          {status === "FAILED" && (
            <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm">
              <p className="font-medium text-destructive">The last correlation run failed</p>
              <p className="mt-1 text-muted-foreground">{job.data?.errorMessage ?? "Something went wrong. Please try again."}</p>
            </div>
          )}
          {summary && (
            <p className="text-xs text-muted-foreground">
              Last run {job.data?.completedAt ? new Date(job.data.completedAt).toLocaleString() : ""}: {summary.correlations ?? 0} correlations
              ({summary.strong ?? 0} strong) from {summary.pairsWithEnoughData ?? 0} of {summary.pairsEvaluated ?? 0} theme–metric pairs with
              enough overlapping data{summary.unit ? `, compared per ${summary.unit}` : ""}.
            </p>
          )}
        </div>

        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList aria-label="Filter correlations by direction">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="positive">Positive</TabsTrigger>
            <TabsTrigger value="negative">Negative</TabsTrigger>
          </TabsList>
        </Tabs>

        {list.isLoading ? (
          <LoadingState rows={3} label="Loading correlations" />
        ) : list.isError ? (
          <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<GitCompareArrows className="h-8 w-8" />}
            title={filter === "all" ? "No correlations yet" : `No ${filter} correlations`}
            description={
              filter === "all"
                ? "Correlation needs a completed synthesis (customer themes) and imported usage data covering the same period as your feedback. Then run correlation."
                : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            <ul className="space-y-3">
              {rows.map((c) => (
                <li key={c.id}>
                  <CorrelationCard correlation={c} />
                </li>
              ))}
            </ul>
            {list.hasNextPage && (
              <div className="flex justify-center">
                <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                  {list.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
