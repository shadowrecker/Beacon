"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ThumbsUp } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { RatingStars } from "./rating-stars";

export function ReviewList({ slug, canVote }: { slug: string; canVote: boolean }) {
  const utils = trpc.useUtils();
  const [sort, setSort] = useState<"recent" | "helpful">("recent");
  const reviews = trpc.marketplace.getReviews.useInfiniteQuery({ slug, sort, limit: 10 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const vote = trpc.marketplace.markReviewHelpful.useMutation({
    onSuccess: () => utils.marketplace.getReviews.invalidate({ slug }),
  });
  const items = reviews.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section aria-labelledby="reviews-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="reviews-heading" className="text-lg font-semibold">
          Reviews
        </h2>
        <div className="flex items-center gap-2">
          <Label htmlFor="review-sort" className="text-sm text-muted-foreground">
            Sort by
          </Label>
          <Select value={sort} onValueChange={(v) => setSort(v as "recent" | "helpful")}>
            <SelectTrigger id="review-sort" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Most recent</SelectItem>
              <SelectItem value="helpful">Most helpful</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {reviews.isLoading ? (
        <LoadingState rows={2} label="Loading reviews" />
      ) : reviews.isError ? (
        <ErrorState message={reviews.error.message} onRetry={() => void reviews.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="No reviews yet" description="Workspaces that install this connector can review it." />
      ) : (
        <>
          <ul className="divide-y rounded-lg border">
            {items.map((r) => (
              <li key={r.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <RatingStars value={r.rating} />
                    {r.title && <span className="font-medium">{r.title}</span>}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {r.authorName}
                    {r.isMine ? " (you)" : ""} · <time dateTime={new Date(r.createdAt).toISOString()}>{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</time>
                  </span>
                </div>
                {r.content && <p className="whitespace-pre-line text-sm">{r.content}</p>}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  {!r.isMine && canVote ? (
                    <Button
                      variant={r.votedHelpful ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={r.votedHelpful}
                      onClick={() => vote.mutate({ reviewId: r.id, helpful: !r.votedHelpful })}
                      disabled={vote.isPending}
                    >
                      <ThumbsUp className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                      Helpful
                    </Button>
                  ) : null}
                  <span>
                    {r.helpful} {r.helpful === 1 ? "person" : "people"} found this helpful
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {reviews.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void reviews.fetchNextPage()} disabled={reviews.isFetchingNextPage}>
                {reviews.isFetchingNextPage ? "Loading…" : "Load more reviews"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
