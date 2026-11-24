"use client";

import { useState } from "react";
import Link from "next/link";
import { format, formatDistanceToNow } from "date-fns";
import { BellOff, Check, CheckCheck } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/** Full, paginated notification list with unread filter and mark-as-read. */
export function NotificationList() {
  const utils = trpc.useUtils();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = trpc.collaboration.getNotifications.useInfiniteQuery(
    { limit: 20, unreadOnly },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const unread = trpc.collaboration.unreadCount.useQuery();
  const refresh = () => Promise.all([utils.collaboration.unreadCount.invalidate(), utils.collaboration.getNotifications.invalidate()]);
  const markRead = trpc.collaboration.markRead.useMutation({ onSuccess: refresh });
  const markAllRead = trpc.collaboration.markAllRead.useMutation({
    onSuccess: async (res) => {
      toast.success(res.updated === 1 ? "Marked 1 notification as read" : `Marked ${res.updated} notifications as read`);
      await refresh();
    },
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const unreadCount = unread.data?.count ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch id="unread-only" checked={unreadOnly} onCheckedChange={setUnreadOnly} />
          <Label htmlFor="unread-only" className="font-normal">
            Unread only
          </Label>
        </div>
        <Button variant="outline" size="sm" disabled={unreadCount === 0 || markAllRead.isPending} onClick={() => markAllRead.mutate()}>
          <CheckCheck className="mr-2 h-4 w-4" aria-hidden />
          Mark all as read{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </Button>
      </div>

      {list.isLoading ? (
        <LoadingState rows={5} label="Loading notifications" />
      ) : list.isError ? (
        <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BellOff className="h-8 w-8" />}
          title={unreadOnly ? "No unread notifications" : "No notifications yet"}
          description="Mentions, replies, finished analyses and team updates will appear here."
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((n) => (
            <li key={n.id} className={cn("flex items-start gap-3 px-4 py-3", !n.isRead && "bg-primary/5")}>
              <span
                className={cn("mt-2 h-2 w-2 flex-shrink-0 rounded-full", n.isRead ? "bg-transparent" : "bg-primary")}
                aria-label={n.isRead ? undefined : "Unread"}
              />
              <div className="min-w-0 flex-1">
                {n.href ? (
                  <Link
                    href={n.href}
                    className="font-medium hover:underline"
                    onClick={() => {
                      if (!n.isRead) markRead.mutate({ ids: [n.id] });
                    }}
                  >
                    {n.title}
                  </Link>
                ) : (
                  <p className="font-medium">{n.title}</p>
                )}
                {n.message && <p className="mt-0.5 whitespace-pre-line text-sm text-muted-foreground">{n.message}</p>}
                <time
                  className="mt-1 block text-xs text-muted-foreground"
                  dateTime={new Date(n.createdAt).toISOString()}
                  title={format(new Date(n.createdAt), "PPpp")}
                >
                  {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                </time>
              </div>
              {!n.isRead && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Mark "${n.title}" as read`}
                  disabled={markRead.isPending}
                  onClick={() => markRead.mutate({ ids: [n.id] })}
                >
                  <Check className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {list.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? "Loading…" : "Load older notifications"}
          </Button>
        </div>
      )}
    </div>
  );
}
