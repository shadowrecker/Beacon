"use client";

import { useCallback, useState } from "react";
import { Store } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { CategoryFilter, type Category } from "./category-filter";
import { ConnectorCard } from "./connector-card";
import { SearchBar } from "./search-bar";

/** Featured connectors (most installed official connectors). */
export function FeaturedConnectors() {
  const featured = trpc.marketplace.getFeatured.useQuery();
  if (featured.isLoading) return <LoadingState rows={1} label="Loading featured connectors" />;
  if (featured.isError) return <ErrorState message={featured.error.message} onRetry={() => void featured.refetch()} />;
  if (!featured.data?.length) return null;
  return (
    <section aria-labelledby="featured-heading" className="space-y-3">
      <h2 id="featured-heading" className="text-lg font-semibold">
        Featured
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {featured.data.map((c) => (
          <li key={c.id}>
            <ConnectorCard connector={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Searchable, filterable catalog with cursor pagination. */
export function MarketplaceGrid() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const onSearch = useCallback((q: string) => setSearch(q), []);
  const browse = trpc.marketplace.browse.useInfiniteQuery(
    { search: search || undefined, category: category ?? undefined, limit: 24 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const items = browse.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section aria-labelledby="catalog-heading" className="space-y-4">
      <h2 id="catalog-heading" className="sr-only">
        All connectors
      </h2>
      <div className="flex flex-col gap-3">
        <SearchBar onSearch={onSearch} />
        <CategoryFilter value={category} onChange={setCategory} />
      </div>
      {browse.isLoading ? (
        <LoadingState rows={3} label="Loading connectors" />
      ) : browse.isError ? (
        <ErrorState message={browse.error.message} onRetry={() => void browse.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Store className="h-8 w-8" />}
          title="No connectors match"
          description={search || category ? "Try a different search or category." : "The catalog is empty."}
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {items.length} connector{items.length === 1 ? "" : "s"}
            {browse.hasNextPage ? " shown" : ""}
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((c) => (
              <li key={c.id}>
                <ConnectorCard connector={c} />
              </li>
            ))}
          </ul>
          {browse.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void browse.fetchNextPage()} disabled={browse.isFetchingNextPage}>
                {browse.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** The active workspace's installed connectors with their integration status. */
export function InstalledConnectors() {
  const installed = trpc.marketplace.listInstalled.useQuery();
  if (installed.isLoading) return <LoadingState rows={2} label="Loading installed connectors" />;
  if (installed.isError) return <ErrorState message={installed.error.message} onRetry={() => void installed.refetch()} />;
  const rows = installed.data ?? [];
  if (rows.length === 0) {
    return <EmptyState icon={<Store className="h-8 w-8" />} title="Nothing installed yet" description="Install a connector from the catalog to start syncing feedback." />;
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((r) => (
        <li key={r.id} className="space-y-2">
          <ConnectorCard connector={{ ...r.connector, installed: true }} />
          <p className="px-1 text-xs text-muted-foreground">
            {r.integration?.status === "CONNECTED"
              ? `Connected${r.integration.lastSyncAt ? ` · last sync ${new Date(r.integration.lastSyncAt).toLocaleString()}` : ""}`
              : r.integration?.status === "ERROR"
                ? "Needs attention: reconnect from Integrations"
                : "Not connected yet: open the connector to finish setup"}
          </p>
        </li>
      ))}
    </ul>
  );
}
