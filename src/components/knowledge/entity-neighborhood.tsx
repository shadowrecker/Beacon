"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Network } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { GraphView } from "./graph-view";

/** Neighborhood graph (1 or 2 hops) around one entity. Clicking a node opens it. */
export function EntityNeighborhood({ entityId, height = 460, onSelect }: { entityId: string; height?: number; onSelect?: (id: string) => void }) {
  const router = useRouter();
  const [depth, setDepth] = useState<1 | 2>(1);
  const hood = trpc.knowledge.getEntityNeighborhood.useQuery({ entityId, depth });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {hood.data ? `${hood.data.nodes.length} entities, ${hood.data.edges.length} relations${hood.data.truncated ? " (showing the strongest connections)" : ""}` : "Connections"}
        </p>
        <div className="flex gap-1" role="group" aria-label="Neighborhood depth">
          {[1, 2].map((d) => (
            <Button key={d} size="sm" variant={depth === d ? "default" : "outline"} aria-pressed={depth === d} onClick={() => setDepth(d as 1 | 2)}>
              {d} hop{d === 2 ? "s" : ""}
            </Button>
          ))}
        </div>
      </div>
      {hood.isLoading ? (
        <LoadingState rows={1} label="Loading graph" />
      ) : hood.isError ? (
        <ErrorState message={hood.error.message} onRetry={() => void hood.refetch()} />
      ) : !hood.data || hood.data.edges.length === 0 ? (
        <EmptyState icon={<Network className="h-8 w-8" />} title="No connections yet" description="Relations appear as more feedback mentioning this entity is processed." />
      ) : (
        <GraphView
          nodes={hood.data.nodes}
          edges={hood.data.edges}
          centerId={hood.data.center.id}
          height={height}
          label={`Knowledge graph around ${hood.data.center.name}`}
          onNodeClick={(id) => (onSelect ? onSelect(id) : router.push(`/knowledge/${id}`))}
        />
      )}
    </div>
  );
}
