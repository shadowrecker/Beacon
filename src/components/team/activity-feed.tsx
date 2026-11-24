"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { History } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { MemberAvatar } from "./member-list";

export function ActivityFeed({ orgId, projectId, limit = 20 }: { orgId: string; projectId?: string; limit?: number }) {
  const feed = trpc.team.activityFeed.useInfiniteQuery(
    { orgId, projectId, limit },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];

  if (feed.isLoading) return <LoadingState rows={4} label="Loading activity" />;
  if (feed.isError) return <ErrorState message={feed.error.message} onRetry={() => void feed.refetch()} />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<History className="h-8 w-8" />}
        title="No activity yet"
        description="Uploads, syntheses, recommendations, comments and membership changes show up here as your team works."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-4" aria-label="Team activity">
        {items.map((a) => (
          <li key={a.id} className="flex gap-3">
            <MemberAvatar name={a.actor.name} avatarUrl={a.actor.avatarUrl} />
            <div className="min-w-0 flex-1 text-sm">
              <p>
                <span className="font-medium">{a.actor.name}</span>{" "}
                {a.href ? (
                  <Link href={a.href} className="hover:underline">
                    {a.summary}
                  </Link>
                ) : (
                  a.summary
                )}
                {a.project && (
                  <>
                    {" "}
                    in{" "}
                    <Link href={`/projects/${a.project.id}`} className="font-medium hover:underline">
                      {a.project.name}
                    </Link>
                  </>
                )}
              </p>
              <time className="text-xs text-muted-foreground" dateTime={new Date(a.createdAt).toISOString()}>
                {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}
              </time>
            </div>
          </li>
        ))}
      </ol>
      {feed.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void feed.fetchNextPage()} disabled={feed.isFetchingNextPage}>
            {feed.isFetchingNextPage ? "Loading…" : "Load older activity"}
          </Button>
        </div>
      )}
    </div>
  );
}
