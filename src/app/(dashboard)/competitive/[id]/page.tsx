"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, ArrowLeft, Trash2 } from "lucide-react";
import { CompetitorUpdates } from "@/components/competitive/competitor-updates";
import { ConfirmDialog } from "@/components/competitive/confirm-dialog";
import { EditCompetitorDialog } from "@/components/competitive/edit-competitor-dialog";
import { ManualUpdateForm } from "@/components/competitive/manual-update-form";
import { ExternalLink } from "@/components/competitive/safe-link";
import { ScanButton } from "@/components/competitive/scan-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";

export default function CompetitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const competitor = trpc.competitive.getCompetitor.useQuery({ id });
  const remove = trpc.competitive.removeCompetitor.useMutation({
    onSuccess: async () => {
      toast.success("Competitor removed.");
      await utils.competitive.listCompetitors.invalidate();
      router.push("/competitive");
    },
  });

  if (competitor.isLoading) return <LoadingState rows={4} label="Loading competitor" />;
  if (competitor.isError || !competitor.data) {
    return <ErrorState message={competitor.error?.message ?? "Competitor not found"} onRetry={() => void competitor.refetch()} />;
  }
  const c = competitor.data;
  const monitorable = !!c.website || !!c.captureUrl;

  return (
    <div className="space-y-8">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/competitive">
          <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
          Competitors
        </Link>
      </Button>

      <header className="flex flex-col gap-4 border-b pb-6 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-bold">{c.name}</h1>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {c.website && <ExternalLink href={c.website} />}
            {c.captureUrl && <ExternalLink href={c.captureUrl}>Monitored page</ExternalLink>}
            {c.g2Url && <ExternalLink href={c.g2Url}>G2 reviews</ExternalLink>}
          </div>
          {c.description && <p className="max-w-2xl whitespace-pre-line text-muted-foreground">{c.description}</p>}
          <p className="text-xs text-muted-foreground">
            {c.updateCount} update{c.updateCount === 1 ? "" : "s"} ·{" "}
            {c.lastScannedAt ? `last scanned ${formatDistanceToNow(c.lastScannedAt, { addSuffix: true })}` : monitorable ? "not scanned yet" : "add a website to enable scans"}
          </p>
          {c.lastScanError && (
            <p role="status" className="flex items-start gap-1.5 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
              Last scan failed: {c.lastScanError}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 flex-wrap gap-2">
          {c.canScan && monitorable && <ScanButton competitorId={c.id} activeJobId={c.activeScanId} />}
          {c.canEdit && <EditCompetitorDialog competitor={c} />}
          {c.canEdit && (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm(true)}>
              <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
              Remove
            </Button>
          )}
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[1fr,380px]">
        <CompetitorUpdates competitorId={c.id} canEdit={c.canEdit} />
        {c.canEdit && (
          <aside>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Add an update</CardTitle>
              </CardHeader>
              <CardContent>
                <ManualUpdateForm competitorId={c.id} />
              </CardContent>
            </Card>
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${c.name}?`}
        description="Its updates and alerts are deleted too. This can't be undone."
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ id: c.id })}
      />
    </div>
  );
}
