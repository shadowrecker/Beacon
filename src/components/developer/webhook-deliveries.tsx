"use client";

import { formatDistanceToNow } from "date-fns";
import { Inbox } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";

const STATUS: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200" },
  retrying: { label: "Retrying", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300" },
  delivered: { label: "Delivered", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
  failed: { label: "Failed", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
};

export function DeliveryStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, className: "" };
  return <Badge className={`border-transparent ${s.className}`}>{s.label}</Badge>;
}

export function WebhookDeliveries({ webhookId }: { webhookId: string }) {
  const deliveries = trpc.webhook.getDeliveries.useInfiniteQuery(
    { webhookId, limit: 20 },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      refetchInterval: (q) =>
        q.state.data?.pages.some((p) => p.items.some((d) => d.status === "pending" || d.status === "retrying")) ? 5000 : false,
    }
  );

  if (deliveries.isLoading) return <LoadingState rows={2} label="Loading deliveries" />;
  if (deliveries.isError) return <ErrorState message={deliveries.error.message} onRetry={() => void deliveries.refetch()} />;
  const items = deliveries.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return <EmptyState icon={<Inbox className="h-6 w-6" />} title="No deliveries yet" description="Send a test delivery or wait for a subscribed event." />;
  }

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Recent deliveries</caption>
          <thead>
            <tr className="text-left text-xs text-gray-500">
              <th scope="col" className="pb-2 font-medium">Event</th>
              <th scope="col" className="pb-2 font-medium">Status</th>
              <th scope="col" className="pb-2 font-medium">HTTP</th>
              <th scope="col" className="pb-2 font-medium">Attempts</th>
              <th scope="col" className="pb-2 font-medium">Duration</th>
              <th scope="col" className="pb-2 font-medium">Created</th>
              <th scope="col" className="pb-2 font-medium">Response</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id} className="border-t align-top dark:border-gray-800">
                <td className="py-1.5 pr-2 font-mono text-xs">{d.event}</td>
                <td className="py-1.5 pr-2">
                  <DeliveryStatusBadge status={d.status} />
                </td>
                <td className="py-1.5 pr-2 tabular-nums">{d.statusCode ?? "–"}</td>
                <td className="py-1.5 pr-2 tabular-nums">{d.attemptCount}</td>
                <td className="py-1.5 pr-2 tabular-nums">{d.durationMs === null ? "–" : `${d.durationMs} ms`}</td>
                <td className="py-1.5 pr-2 text-xs text-gray-500" title={new Date(d.createdAt).toLocaleString()}>
                  {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
                </td>
                <td className="max-w-xs truncate py-1.5 font-mono text-xs text-gray-500" title={d.responseExcerpt ?? undefined}>
                  {d.responseExcerpt ?? "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {deliveries.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void deliveries.fetchNextPage()} disabled={deliveries.isFetchingNextPage}>
          {deliveries.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
