"use client";

/**
 * Recommendations page body: generate from the latest synthesis (a JobRun the
 * page polls via job.get until READY/FAILED), filter, and act on items.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Lightbulb, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import type { RouterInputs } from "@/lib/trpc";
import { trpc } from "@/lib/trpc/client";
import { RecommendationCard } from "./recommendation-card";

type Filters = Pick<RouterInputs["recommendation"]["list"], "status" | "impact">;
const POLL_MS = 2_000;

export function RecommendationsWorkspace({
  projectId,
  canWrite,
  canRunAI,
  hasSynthesis,
}: {
  projectId: string;
  canWrite: boolean;
  canRunAI: boolean;
  hasSynthesis: boolean;
}) {
  const statusId = useId();
  const impactId = useId();
  const utils = trpc.useUtils();
  const [filters, setFilters] = useState<Filters>({});
  const [jobRunId, setJobRunId] = useState<string | null>(null);

  const list = trpc.recommendation.list.useInfiniteQuery({ projectId, limit: 20, ...filters }, { getNextPageParam: (last) => last.nextCursor });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);

  const generate = trpc.recommendation.generate.useMutation({
    onSuccess: (res) => {
      setJobRunId(res.jobRunId);
      toast.info("Generating recommendations from the latest synthesis…");
    },
  });

  const job = trpc.job.get.useQuery(
    { id: jobRunId ?? "" },
    {
      enabled: Boolean(jobRunId),
      refetchInterval: (q) => (q.state.data && (q.state.data.status === "READY" || q.state.data.status === "FAILED") ? false : POLL_MS),
    }
  );

  useEffect(() => {
    const run = job.data;
    if (!run || run.id !== jobRunId || (run.status !== "READY" && run.status !== "FAILED")) return;
    setJobRunId(null);
    if (run.status === "READY") {
      const count = (run.output as { count?: number } | null)?.count;
      toast.success(typeof count === "number" ? `${count} recommendations ready` : "Recommendations ready");
      void Promise.all([utils.recommendation.list.invalidate({ projectId }), utils.project.getById.invalidate({ id: projectId })]);
    } else {
      toast.error(run.errorMessage ?? "Generating recommendations failed");
    }
  }, [job.data, jobRunId, projectId, utils]);

  const generating = generate.isPending || Boolean(jobRunId);
  const generateButton = canRunAI ? (
    <Button onClick={() => generate.mutate({ projectId })} disabled={generating || !hasSynthesis}>
      {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="mr-2 h-4 w-4" aria-hidden />}
      {generating ? "Generating…" : "Generate recommendations"}
    </Button>
  ) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <Label htmlFor={statusId} className="text-xs">
              Status
            </Label>
            <select
              id={statusId}
              value={filters.status ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, status: (e.target.value || undefined) as Filters["status"] }))}
              className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            >
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="ACCEPTED">Accepted</option>
              <option value="IMPLEMENTED">Implemented</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={impactId} className="text-xs">
              Impact
            </Label>
            <select
              id={impactId}
              value={filters.impact ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, impact: (e.target.value || undefined) as Filters["impact"] }))}
              className="h-10 rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            >
              <option value="">All</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
          </div>
        </div>
        {generateButton}
      </div>
      {canRunAI && !hasSynthesis && <p className="text-sm text-muted-foreground">Run a synthesis first: recommendations are based on its themes.</p>}
      {jobRunId && (
        <p role="status" className="text-sm text-muted-foreground">
          Working through the synthesis themes. This usually takes under a minute.
        </p>
      )}

      {list.isLoading ? (
        <LoadingState rows={3} label="Loading recommendations" />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filters.status || filters.impact ? (
          <EmptyState title="No matching recommendations" description="Try a different filter." />
        ) : (
          <EmptyState
            icon={<Lightbulb className="h-8 w-8" />}
            title="No recommendations yet"
            description="Recommendations turn synthesis themes into concrete product actions, each with its impact, confidence and the customer evidence behind it."
            action={generateButton}
          />
        )
      ) : (
        <>
          <div className="space-y-4">
            {items.map((rec) => (
              <RecommendationCard key={rec.id} projectId={projectId} rec={rec} canWrite={canWrite} canRunAI={canRunAI} />
            ))}
          </div>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                {list.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
