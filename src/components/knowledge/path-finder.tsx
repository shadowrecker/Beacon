"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Route } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { EntityPicker } from "./entity-picker";
import { EntityTypeBadge, type EntitySummary } from "./entity-card";
import { typeLabel } from "./constants";

/** Shortest connection (up to 4 hops) between two entities. */
export function PathFinder() {
  const [from, setFrom] = useState<EntitySummary | null>(null);
  const [to, setTo] = useState<EntitySummary | null>(null);
  const path = trpc.knowledge.findShortestPath.useQuery({ sourceId: from?.id ?? "", targetId: to?.id ?? "" }, { enabled: !!from && !!to });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <EntityPicker label="From" value={from} onChange={setFrom} />
        <EntityPicker label="To" value={to} onChange={setTo} />
      </div>
      {!from || !to ? (
        <EmptyState icon={<Route className="h-8 w-8" />} title="Pick two entities" description="See how two customers, features or pain points are connected through the feedback." />
      ) : path.isLoading ? (
        <LoadingState rows={1} label="Finding path" />
      ) : path.isError ? (
        <ErrorState message={path.error.message} onRetry={() => void path.refetch()} />
      ) : !path.data?.found ? (
        <EmptyState title="No connection within 4 hops" description="These entities are not linked closely in the feedback processed so far." />
      ) : (
        <ol className="flex flex-wrap items-center gap-2" aria-label="Path">
          {path.data.steps.map((s, i) => (
            <li key={s.node.id} className="flex items-center gap-2">
              {s.relation && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ArrowRight className="h-3 w-3" aria-hidden />
                  {typeLabel(s.relation.type)}
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </span>
              )}
              <Link href={`/knowledge/${s.node.id}`} className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-sm hover:bg-muted">
                <span className="sr-only">Step {i + 1}: </span>
                {s.node.name}
                <EntityTypeBadge type={s.node.type} />
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
