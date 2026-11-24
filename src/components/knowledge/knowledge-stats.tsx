"use client";

import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { colorFor, typeLabel } from "./constants";

/** Headline numbers for the active workspace's graph. */
export function KnowledgeStats() {
  const stats = trpc.knowledge.getStats.useQuery();
  if (stats.isLoading) return <LoadingState rows={1} label="Loading graph statistics" />;
  if (stats.isError) return <ErrorState message={stats.error.message} onRetry={() => void stats.refetch()} />;
  const s = stats.data;
  if (!s) return null;
  const tiles = [
    { label: "Entities", value: s.entityCount },
    { label: "Relations", value: s.relationCount },
    { label: "Pending merge reviews", value: s.pendingMergeSuggestions },
    { label: "Questions asked", value: s.queryCount },
  ];
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border p-4">
            <dt className="text-xs text-muted-foreground">{t.label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{t.value.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {s.byType.length > 0 && (
        <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="Entities by type">
          {s.byType.map((t) => (
            <li key={t.type} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorFor(t.type) }} aria-hidden />
              {typeLabel(t.type)}: <span className="tabular-nums">{t.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Most connected entities; selecting one focuses it. */
export function TopHubs({ selectedId, onSelect }: { selectedId?: string | null; onSelect: (id: string) => void }) {
  const hubs = trpc.knowledge.getTopHubs.useQuery({ limit: 10 });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Most connected</CardTitle>
      </CardHeader>
      <CardContent>
        {hubs.isLoading ? (
          <LoadingState rows={3} label="Loading hubs" />
        ) : hubs.isError ? (
          <ErrorState message={hubs.error.message} onRetry={() => void hubs.refetch()} />
        ) : (hubs.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No entities yet.</p>
        ) : (
          <ol className="space-y-1">
            {hubs.data!.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  aria-pressed={h.id === selectedId}
                  onClick={() => onSelect(h.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 aria-pressed:bg-muted"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: colorFor(h.type) }} aria-hidden />
                    <span className="truncate">{h.name}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{h.degree} links</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
