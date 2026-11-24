"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, Bell, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { ConfirmDialog } from "./confirm-dialog";
import { UPDATE_TYPE_LABEL, type UpdateType } from "./labels";
import { ExternalLink } from "./safe-link";
import { ScanButton } from "./scan-button";

type Competitor = RouterOutputs["competitive"]["listCompetitors"]["items"][number];

export function CompetitorCard({ competitor, canEdit, canScan }: { competitor: Competitor; canEdit: boolean; canScan: boolean }) {
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const remove = trpc.competitive.removeCompetitor.useMutation({
    onSuccess: async () => {
      setConfirm(false);
      toast.success(`${competitor.name} removed.`);
      await utils.competitive.invalidate();
    },
  });
  const monitorable = !!competitor.website || !!competitor.captureUrl;

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg">
            <Link href={`/competitive/${competitor.id}`} className="hover:underline">
              {competitor.name}
            </Link>
          </CardTitle>
          {competitor.unreadAlerts > 0 && (
            <Badge variant="high" className="flex-shrink-0 gap-1">
              <Bell className="h-3 w-3" aria-hidden />
              {competitor.unreadAlerts}
              <span className="sr-only">unread alerts</span>
            </Badge>
          )}
        </div>
        {competitor.website && <ExternalLink href={competitor.website} className="max-w-full text-sm" />}
      </CardHeader>
      <CardContent className="flex-1 space-y-3 text-sm">
        {competitor.description && <p className="line-clamp-3 text-muted-foreground">{competitor.description}</p>}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Latest update</p>
          {competitor.latestUpdate ? (
            <p className="mt-1">
              <Badge variant="secondary" className="mr-2">
                {UPDATE_TYPE_LABEL[competitor.latestUpdate.type as UpdateType] ?? competitor.latestUpdate.type}
              </Badge>
              <span className="font-medium">{competitor.latestUpdate.title}</span>
              <span className="text-muted-foreground"> · {formatDistanceToNow(competitor.latestUpdate.detectedAt, { addSuffix: true })}</span>
            </p>
          ) : (
            <p className="mt-1 text-muted-foreground">No updates yet</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {competitor.updateCount} update{competitor.updateCount === 1 ? "" : "s"} ·{" "}
          {competitor.lastScannedAt ? `scanned ${formatDistanceToNow(competitor.lastScannedAt, { addSuffix: true })}` : monitorable ? "not scanned yet" : "no pages to monitor"}
        </p>
        {competitor.lastScanError && (
          <p role="status" className="flex items-start gap-1.5 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            <span>Last scan failed: {competitor.lastScanError}</span>
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 border-t pt-4">
        <Button asChild size="sm" variant="secondary">
          <Link href={`/competitive/${competitor.id}`}>View timeline</Link>
        </Button>
        {canScan && monitorable && <ScanButton competitorId={competitor.id} />}
        {canEdit && (
          <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Remove ${competitor.name}`} onClick={() => setConfirm(true)}>
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        )}
      </CardFooter>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${competitor.name}?`}
        description="Its updates and alerts are deleted too. This can't be undone."
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ id: competitor.id })}
      />
    </Card>
  );
}
