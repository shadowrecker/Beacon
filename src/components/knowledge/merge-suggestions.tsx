"use client";

import Link from "next/link";
import { GitMerge } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { EntityTypeBadge } from "./entity-card";

type Suggestion = RouterOutputs["knowledge"]["listMergeSuggestions"]["items"][number];
type Side = Suggestion["source"];

function SideSummary({ entity, heading }: { entity: Side; heading: string }) {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/knowledge/${entity.id}`} className="font-medium hover:underline">
          {entity.name}
        </Link>
        <EntityTypeBadge type={entity.type} />
      </div>
      <p className="text-xs text-muted-foreground">{entity.mentionCount} mentions</p>
      {entity.description && <p className="line-clamp-2 text-xs text-muted-foreground">{entity.description}</p>}
      {entity.aliases.length > 0 && <p className="text-xs text-muted-foreground">Also known as: {entity.aliases.join(", ")}</p>}
    </div>
  );
}

/** Review likely-duplicate entity pairs. Merges happen only when a member accepts one. */
export function MergeSuggestions() {
  const utils = trpc.useUtils();
  const list = trpc.knowledge.listMergeSuggestions.useInfiniteQuery({ limit: 20 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const refresh = () =>
    Promise.all([
      utils.knowledge.listMergeSuggestions.invalidate(),
      utils.knowledge.getStats.invalidate(),
      utils.knowledge.listEntities.invalidate(),
      utils.knowledge.getTopHubs.invalidate(),
    ]);
  const accept = trpc.knowledge.acceptMergeSuggestion.useMutation({
    onSuccess: async () => {
      toast.success("Entities merged");
      await refresh();
    },
  });
  const reject = trpc.knowledge.rejectMergeSuggestion.useMutation({
    onSuccess: async () => {
      toast.success("Suggestion dismissed");
      await refresh();
    },
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const canWrite = list.data?.pages[0]?.permissions.canWrite ?? false;
  const busy = accept.isPending || reject.isPending;

  if (list.isLoading) return <LoadingState rows={3} label="Loading merge suggestions" />;
  if (list.isError) return <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />;
  if (items.length === 0) {
    return <EmptyState icon={<GitMerge className="h-8 w-8" />} title="No merge suggestions" description="Likely duplicate entities are flagged here for review. Nothing is merged automatically." />;
  }

  return (
    <div className="space-y-3">
      {!canWrite && <p className="text-sm text-muted-foreground">You can review suggestions; members with edit access can merge them.</p>}
      <ul className="space-y-3">
        {items.map((s) => (
          <li key={s.id}>
            <Card>
              <CardContent className="space-y-4 pt-6">
                <div className="flex flex-col gap-4 sm:flex-row">
                  <SideSummary entity={s.target} heading="Keep" />
                  <SideSummary entity={s.source} heading="Merge in" />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">Similarity {Math.round(s.similarity * 100)}%</span>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" disabled={!canWrite || busy} onClick={() => reject.mutate({ suggestionId: s.id })}>
                      Not duplicates
                    </Button>
                    <Button size="sm" variant="outline" disabled={!canWrite || busy} onClick={() => accept.mutate({ suggestionId: s.id, keep: "source" })}>
                      Keep “{s.source.name}”
                    </Button>
                    <Button size="sm" disabled={!canWrite || busy} onClick={() => accept.mutate({ suggestionId: s.id, keep: "target" })}>
                      <GitMerge className="mr-2 h-4 w-4" aria-hidden />
                      Merge into “{s.target.name}”
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <Button variant="outline" className="w-full" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  );
}
