"use client";

import { use, useEffect, useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { trpc } from "@/lib/trpc";
import { RoadmapSelector } from "@/components/roadmap/roadmap-selector";
import { ImportDialog } from "@/components/roadmap/import-dialog";
import { RoadmapView } from "@/components/roadmap/roadmap-view";
import { GapAnalysisView } from "@/components/roadmap/gap-analysis-view";

export default function RoadmapPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const roadmaps = trpc.roadmap.list.useQuery({ projectId, limit: 100 });
  const items = roadmaps.data?.items ?? [];

  // Default to the most recent roadmap; drop a selection that no longer exists.
  useEffect(() => {
    if (!roadmaps.data) return;
    const list = roadmaps.data.items;
    if (selectedId && list.some((r) => r.id === selectedId)) return;
    setSelectedId(list[0]?.id ?? null);
  }, [roadmaps.data, selectedId]);

  const selected = items.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">Roadmap</h2>
        <p className="text-sm text-muted-foreground">
          Bring in your roadmap and see which customer themes it covers, partially covers or misses.
        </p>
      </div>

      {roadmaps.isLoading ? (
        <LoadingState rows={2} label="Loading roadmaps" />
      ) : roadmaps.isError ? (
        <ErrorState message={roadmaps.error.message} onRetry={() => void roadmaps.refetch()} />
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <RoadmapSelector projectId={projectId} roadmaps={items} selectedId={selectedId} onSelect={setSelectedId} />
            <ImportDialog projectId={projectId} roadmap={selected ? { id: selected.id, name: selected.name } : null} onImported={setSelectedId} />
          </div>
          {roadmaps.data?.nextCursor && (
            <p className="text-xs text-muted-foreground">Showing the 100 most recent roadmaps.</p>
          )}

          {!selected ? (
            <EmptyState
              icon={<MapIcon className="h-8 w-8" />}
              title="No roadmaps yet"
              description="Create a roadmap and add items, or import one from a CSV file, Linear, Jira or Notion."
            />
          ) : (
            <div className="grid gap-6 xl:grid-cols-2">
              <RoadmapView projectId={projectId} roadmapId={selected.id} />
              <GapAnalysisView projectId={projectId} roadmapId={selected.id} itemCount={selected.itemCount} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
