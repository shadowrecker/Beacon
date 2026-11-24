"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ENTITY_TYPES, typeLabel, type EntityTypeName } from "./constants";
import { EntityCard } from "./entity-card";

type Sort = "mentions" | "recent" | "name";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search and filter entities (paginated). Selecting an entity calls `onSelect`. */
export function KnowledgeSearch({ selectedId, onSelect }: { selectedId?: string | null; onSelect?: (id: string) => void }) {
  const [text, setText] = useState("");
  const [type, setType] = useState<EntityTypeName | "ALL">("ALL");
  const [sort, setSort] = useState<Sort>("mentions");
  const search = useDebounced(text.trim());

  const list = trpc.knowledge.listEntities.useInfiniteQuery(
    { search: search || undefined, type: type === "ALL" ? undefined : type, sort, limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="kg-search">Search entities</Label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input id="kg-search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, alias or description" className="pl-9" maxLength={200} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="kg-type">Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as EntityTypeName | "ALL")}>
            <SelectTrigger id="kg-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All types</SelectItem>
              {ENTITY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {typeLabel(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="kg-sort">Sort by</Label>
          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger id="kg-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mentions">Most mentioned</SelectItem>
              <SelectItem value="recent">Recently seen</SelectItem>
              <SelectItem value="name">Name</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {list.isLoading ? (
        <LoadingState rows={4} label="Loading entities" />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={search || type !== "ALL" ? "No matching entities" : "No entities yet"}
          description={search || type !== "ALL" ? "Try a different search or type." : "Entities are extracted automatically as documents finish processing."}
        />
      ) : (
        <ul className="space-y-2" aria-label="Entities">
          {items.map((e) => (
            <li key={e.id}>
              <EntityCard entity={e} selected={e.id === selectedId} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button variant="outline" className="w-full" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
