"use client";

/**
 * Presentations of one project: paginated, polling only while any listed deck
 * is GENERATING, with regenerate and delete (confirmed).
 */
import { useState } from "react";
import Link from "next/link";
import { FileText, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { PresentationCard } from "./presentation-card";
import type { PresentationListItem } from "./theme";

const POLL_MS = 4_000;

export function PresentationList({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const [toDelete, setToDelete] = useState<PresentationListItem | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  const query = trpc.presentation.list.useInfiniteQuery(
    { projectId, limit: 20 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (q) =>
        q.state.data?.pages.some((pg) => pg.items.some((i) => i.status === "GENERATING")) ? POLL_MS : false,
    }
  );

  const regenerate = trpc.presentation.regenerate.useMutation({
    onMutate: ({ id }) => setRegeneratingId(id),
    onSuccess: async () => {
      toast.success("Regenerating the presentation");
      await utils.presentation.list.invalidate({ projectId });
    },
    onSettled: () => setRegeneratingId(null),
  });

  const remove = trpc.presentation.delete.useMutation({
    onSuccess: async (_d, { id }) => {
      toast.success("Presentation deleted");
      setToDelete(null);
      await utils.presentation.list.invalidate({ projectId });
      await utils.presentation.get.invalidate({ id });
    },
  });

  if (query.isLoading) return <LoadingState rows={3} label="Loading presentations" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;

  const items = query.data?.pages.flatMap((pg) => pg.items) ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="h-8 w-8" />}
        title="No presentations yet"
        description="Generate a stakeholder deck from this project's themes, recommendations and outcomes."
        action={
          <Button asChild className="gap-2">
            <Link href={`/presentations/new?project=${encodeURIComponent(projectId)}`}>
              <Plus className="h-4 w-4" aria-hidden />
              New presentation
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-3" aria-label="Presentations">
        {items.map((p) => (
          <li key={p.id}>
            <PresentationCard
              presentation={p}
              onRegenerate={(id) => regenerate.mutate({ id })}
              onDelete={setToDelete}
              regenerating={regeneratingId === p.id}
            />
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete presentation?"
        description={toDelete ? `"${toDelete.title}" and its PPTX and PDF files will be permanently deleted.` : undefined}
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => toDelete && remove.mutate({ id: toDelete.id })}
      />
    </div>
  );
}
