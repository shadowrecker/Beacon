"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { CitationList } from "@/components/query/citation-list";
import { trpc } from "@/lib/trpc/client";

/** All verified evidence for one theme, paginated. */
export function ThemeEvidenceDialog({
  projectId,
  theme,
  open,
  onOpenChange,
}: {
  projectId: string;
  theme: { id: string; name: string; citationCount: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = trpc.synthesis.themeCitations.useInfiniteQuery(
    { projectId, themeId: theme.id, limit: 20 },
    { enabled: open, getNextPageParam: (last) => last.nextCursor }
  );
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{theme.name}</DialogTitle>
          <DialogDescription>
            {theme.citationCount} verified {theme.citationCount === 1 ? "quote" : "quotes"} from customer research. Each opens the passage it came from.
          </DialogDescription>
        </DialogHeader>
        {query.isLoading ? (
          <LoadingState rows={3} label="Loading evidence" />
        ) : query.isError ? (
          <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <CitationList projectId={projectId} citations={items} />
            {query.hasNextPage && (
              <div className="flex justify-center">
                <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {query.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
