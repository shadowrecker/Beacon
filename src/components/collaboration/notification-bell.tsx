"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Topbar bell: unread badge, the latest notifications, mark-as-read. */
export function NotificationBell() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const unread = trpc.collaboration.unreadCount.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const list = trpc.collaboration.getNotifications.useQuery({ limit: 8 }, { enabled: open });
  const markRead = trpc.collaboration.markRead.useMutation({
    onSuccess: () => Promise.all([utils.collaboration.unreadCount.invalidate(), utils.collaboration.getNotifications.invalidate()]),
  });
  const markAllRead = trpc.collaboration.markAllRead.useMutation({
    onSuccess: () => Promise.all([utils.collaboration.unreadCount.invalidate(), utils.collaboration.getNotifications.invalidate()]),
  });

  const count = unread.data?.count ?? 0;
  const label = count > 0 ? `Notifications, ${count} unread` : "Notifications";
  const items = list.data?.items ?? [];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={label}>
          <Bell className="h-5 w-5" aria-hidden />
          {count > 0 && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between px-3 py-2">
          <DropdownMenuLabel className="p-0 text-sm">Notifications</DropdownMenuLabel>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={count === 0 || markAllRead.isPending}
            onClick={() => markAllRead.mutate()}
          >
            <CheckCheck className="mr-1 h-3.5 w-3.5" aria-hidden />
            Mark all read
          </Button>
        </div>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-96 overflow-y-auto">
          {list.isLoading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground" aria-busy="true">
              Loading…
            </p>
          ) : list.isError ? (
            <div role="alert" className="space-y-2 px-3 py-6 text-center text-sm">
              <p className="text-muted-foreground">Couldn&apos;t load notifications.</p>
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">You&apos;re all caught up.</p>
          ) : (
            items.map((n) => (
              <DropdownMenuItem
                key={n.id}
                className={cn("flex cursor-pointer flex-col items-start gap-0.5 rounded-none px-3 py-2.5", !n.isRead && "bg-primary/5")}
                onSelect={() => {
                  if (!n.isRead) markRead.mutate({ ids: [n.id] });
                  if (n.href) router.push(n.href);
                }}
              >
                <span className="flex w-full items-start gap-2">
                  {!n.isRead && <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                  <span className="line-clamp-1 flex-1 text-sm font-medium">{n.title}</span>
                </span>
                {n.message && <span className="line-clamp-2 text-xs text-muted-foreground">{n.message}</span>}
                <time className="text-[11px] text-muted-foreground" dateTime={new Date(n.createdAt).toISOString()}>
                  {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                </time>
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <DropdownMenuItem asChild className="justify-center rounded-none py-2 text-sm">
          <Link href="/notifications">View all notifications</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
