"use client";

import { Swords } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { AddCompetitorDialog } from "@/components/competitive/add-competitor-dialog";
import { AlertsPanel } from "@/components/competitive/alerts-panel";
import { CompetitorCard } from "@/components/competitive/competitor-card";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { trpc } from "@/lib/trpc";

export default function CompetitivePage() {
  const list = trpc.competitive.listCompetitors.useInfiniteQuery({ limit: 50 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const first = list.data?.pages[0];
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canEdit = first?.canEdit ?? false;
  const canScan = first?.canScan ?? false;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Competitive intelligence"
        description="Track competitors' product, pricing and company updates. Sites are scanned daily; significant changes raise alerts."
        actions={canEdit ? <AddCompetitorDialog canScan={canScan} /> : undefined}
      />
      <div className="grid gap-8 lg:grid-cols-[1fr,340px]">
        <section aria-labelledby="competitors-heading" className="space-y-4">
          <h2 id="competitors-heading" className="sr-only">
            Competitors
          </h2>
          {list.isLoading ? (
            <LoadingState rows={3} label="Loading competitors" />
          ) : list.isError ? (
            <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Swords className="h-8 w-8" />}
              title="No competitors yet"
              description="Add a competitor's website and Beacon will watch their changelog, blog and pricing pages."
              action={canEdit ? <AddCompetitorDialog canScan={canScan} /> : undefined}
            />
          ) : (
            <>
              <ul className="grid gap-4 md:grid-cols-2">
                {items.map((c) => (
                  <li key={c.id}>
                    <CompetitorCard competitor={c} canEdit={canEdit} canScan={canScan} />
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
            </>
          )}
        </section>
        <aside>
          <AlertsPanel />
        </aside>
      </div>
    </div>
  );
}
