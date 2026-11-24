"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Bell, Check, CheckCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { ALERT_TYPE_LABEL } from "./labels";

/** The signed-in user's competitor alerts in the active workspace. */
export function AlertsPanel() {
  const utils = trpc.useUtils();
  const [unreadOnly, setUnreadOnly] = useState(true);
  const alerts = trpc.competitive.getAlerts.useInfiniteQuery(
    { unreadOnly, limit: 20 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const markRead = trpc.competitive.markAlertRead.useMutation({
    onSuccess: async () => {
      await utils.competitive.getAlerts.invalidate();
      await utils.competitive.listCompetitors.invalidate();
    },
  });

  const pages = alerts.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const unread = pages[0]?.unread ?? 0;

  return (
    <Card>
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4" aria-hidden />
            Alerts
            {unread > 0 && (
              <Badge variant="high">
                {unread}
                <span className="sr-only"> unread</span>
              </Badge>
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            disabled={unread === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            <CheckCheck className="mr-1.5 h-4 w-4" aria-hidden />
            Mark all read
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="alerts-unread-only" checked={unreadOnly} onCheckedChange={setUnreadOnly} />
          <Label htmlFor="alerts-unread-only" className="text-sm font-normal text-muted-foreground">
            Unread only
          </Label>
        </div>
      </CardHeader>
      <CardContent>
        {alerts.isLoading ? (
          <LoadingState rows={2} label="Loading alerts" />
        ) : alerts.isError ? (
          <ErrorState message={alerts.error.message} onRetry={() => void alerts.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title={unreadOnly ? "You're all caught up" : "No alerts yet"}
            description="You'll be alerted when a scan finds a significant product or pricing change."
          />
        ) : (
          <ul className="divide-y" aria-label="Competitor alerts">
            {items.map((a) => (
              <li key={a.id} className={cn("flex items-start gap-3 py-3", a.isRead && "opacity-70")}>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {ALERT_TYPE_LABEL[a.type] ?? a.type} · {formatDistanceToNow(a.createdAt, { addSuffix: true })}
                  </p>
                  <Link href={`/competitive/${a.competitor.id}`} className="mt-0.5 block text-sm font-medium hover:underline">
                    {a.message}
                  </Link>
                </div>
                {!a.isRead && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 flex-shrink-0"
                    aria-label="Mark alert as read"
                    disabled={markRead.isPending}
                    onClick={() => markRead.mutate({ id: a.id })}
                  >
                    <Check className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {alerts.hasNextPage && (
          <Button variant="outline" size="sm" className="mt-3 w-full" disabled={alerts.isFetchingNextPage} onClick={() => void alerts.fetchNextPage()}>
            {alerts.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
