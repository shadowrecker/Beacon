"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ArrowRight, Quote } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { EntityTypeBadge } from "./entity-card";
import { typeLabel } from "./constants";

type Direction = "both" | "out" | "in";

/** Relations of one entity with their verified evidence quotes, linked to source documents. */
export function EntityRelations({ entityId }: { entityId: string }) {
  const [direction, setDirection] = useState<Direction>("both");
  const list = trpc.knowledge.getRelations.useInfiniteQuery({ entityId, side: direction, limit: 20 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex gap-1" role="group" aria-label="Relation direction">
        {(["both", "out", "in"] as const).map((d) => (
          <Button key={d} size="sm" variant={direction === d ? "default" : "outline"} aria-pressed={direction === d} onClick={() => setDirection(d)}>
            {d === "both" ? "All" : d === "out" ? "Outgoing" : "Incoming"}
          </Button>
        ))}
      </div>
      {list.isLoading ? (
        <LoadingState rows={3} label="Loading relations" />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No relations" description="No relationships with other entities have been found yet." />
      ) : (
        <ul className="space-y-3">
          {items.map((r) => {
            const other = r.direction === "out" ? r.target : r.source;
            return (
              <li key={r.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {r.direction === "out" ? <ArrowRight className="h-4 w-4 text-muted-foreground" aria-label="Outgoing" /> : <ArrowLeft className="h-4 w-4 text-muted-foreground" aria-label="Incoming" />}
                  <span className="font-medium">{typeLabel(r.type)}</span>
                  <Link href={`/knowledge/${other.id}`} className="hover:underline">
                    {other.name}
                  </Link>
                  <EntityTypeBadge type={other.type} />
                  <span className="ml-auto text-xs text-muted-foreground">
                    strength {Math.round(r.strength * 100)}% · {r.documentCount} document{r.documentCount === 1 ? "" : "s"}
                  </span>
                </div>
                {r.evidence.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {r.evidence.map((ev) => (
                      <li key={`${ev.chunkId}:${ev.quote}`} className="flex gap-2 text-sm">
                        <Quote className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
                        <span>
                          <q className="italic">{ev.quote}</q>{" "}
                          <Link href={`/projects/${ev.projectId}/documents/${ev.documentId}`} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
                            {ev.documentTitle}
                          </Link>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage && (
        <Button variant="outline" className="w-full" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  );
}
