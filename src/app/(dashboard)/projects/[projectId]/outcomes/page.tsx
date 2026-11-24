"use client";

import { use, useId, useState } from "react";
import { Plus, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { LearningsPanel } from "@/components/outcomes/learnings-panel";
import { OutcomeCard } from "@/components/outcomes/outcome-card";
import { OutcomeFormDialog } from "@/components/outcomes/outcome-form-dialog";
import { OUTCOME_STATUS_OPTIONS, type OutcomeStatus } from "@/components/outcomes/labels";
import { trpc } from "@/lib/trpc";

type Filter = OutcomeStatus | "ALL";

export default function OutcomesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const filterId = useId();
  const [filter, setFilter] = useState<Filter>("ALL");

  const outcomes = trpc.outcome.getOutcomes.useInfiniteQuery(
    { projectId, limit: 20, ...(filter !== "ALL" ? { status: filter } : {}) },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const items = outcomes.data?.pages.flatMap((p) => p.items) ?? [];

  const trackButton = (
    <OutcomeFormDialog
      projectId={projectId}
      trigger={
        <Button className="gap-2">
          <Plus className="h-4 w-4" aria-hidden />
          Track an outcome
        </Button>
      }
    />
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Outcomes</h2>
          <p className="text-sm text-muted-foreground">
            Measure what happened after recommendations shipped. Implemented recommendations start tracking automatically.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="w-44 space-y-1">
            <Label htmlFor={filterId} className="text-xs">
              Status
            </Label>
            <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
              <SelectTrigger id={filterId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                {OUTCOME_STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {trackButton}
        </div>
      </div>

      <LearningsPanel projectId={projectId} />

      {outcomes.isLoading ? (
        <LoadingState rows={3} label="Loading outcomes" />
      ) : outcomes.isError ? (
        <ErrorState message={outcomes.error.message} onRetry={() => void outcomes.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Target className="h-8 w-8" />}
          title={filter === "ALL" ? "No outcomes tracked yet" : "No outcomes with this status"}
          description={
            filter === "ALL"
              ? "Mark a recommendation as implemented, or track one manually, then record its baseline, target and current values."
              : "Try another status filter."
          }
          action={filter === "ALL" ? trackButton : undefined}
        />
      ) : (
        <div className="space-y-4">
          <ul className="grid gap-4 lg:grid-cols-2" aria-label="Tracked outcomes">
            {items.map((o) => (
              <li key={o.id}>
                <OutcomeCard projectId={projectId} outcome={o} />
              </li>
            ))}
          </ul>
          {outcomes.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void outcomes.fetchNextPage()} disabled={outcomes.isFetchingNextPage}>
                {outcomes.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
