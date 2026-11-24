"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { NativeSelect } from "@/components/voice/native-select";
import { ConfirmDialog } from "./confirm-dialog";
import { SENTIMENT_LABEL, SENTIMENT_VARIANT, UPDATE_TYPE_LABEL, UPDATE_TYPES, type SentimentValue, type UpdateType } from "./labels";
import { ExternalLink } from "./safe-link";

/** Timeline of a competitor's updates (scanned and manual), newest first. */
export function CompetitorUpdates({ competitorId, canEdit }: { competitorId: string; canEdit: boolean }) {
  const utils = trpc.useUtils();
  const [type, setType] = useState<UpdateType | "">("");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const updates = trpc.competitive.getUpdates.useInfiniteQuery(
    { competitorId, type: type || undefined, limit: 20 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const remove = trpc.competitive.deleteUpdate.useMutation({
    onSuccess: async () => {
      setPendingDelete(null);
      toast.success("Update deleted.");
      await Promise.all([utils.competitive.getUpdates.invalidate({ competitorId }), utils.competitive.getCompetitor.invalidate({ id: competitorId }), utils.competitive.listCompetitors.invalidate()]);
    },
  });
  const items = updates.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section aria-labelledby="timeline-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="timeline-heading" className="text-lg font-semibold">
          Timeline
        </h2>
        <div className="w-48 space-y-1">
          <Label htmlFor={`updates-type-${competitorId}`} className="text-xs text-muted-foreground">
            Type
          </Label>
          <NativeSelect id={`updates-type-${competitorId}`} value={type} onChange={(e) => setType(e.target.value as UpdateType | "")}>
            <option value="">All updates</option>
            {UPDATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {UPDATE_TYPE_LABEL[t]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>

      {updates.isLoading ? (
        <LoadingState rows={3} label="Loading updates" />
      ) : updates.isError ? (
        <ErrorState message={updates.error.message} onRetry={() => void updates.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title={type ? "No updates of this type" : "No updates yet"}
          description="Run a scan to check the competitor's site, or add an update by hand."
        />
      ) : (
        <ol className="relative space-y-4 border-l pl-6">
          {items.map((u) => (
            <li key={u.id} className="relative">
              <span className="absolute -left-[31px] top-1.5 h-3 w-3 rounded-full border-2 border-background bg-primary" aria-hidden />
              <div className="space-y-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{UPDATE_TYPE_LABEL[u.type as UpdateType] ?? u.type}</Badge>
                  <Badge variant={SENTIMENT_VARIANT[u.sentiment as SentimentValue]}>{SENTIMENT_LABEL[u.sentiment as SentimentValue]}</Badge>
                  {u.isManual && <Badge variant="outline">Manual</Badge>}
                  <time dateTime={new Date(u.detectedAt).toISOString()} className="text-xs text-muted-foreground">
                    {format(new Date(u.detectedAt), "PP")}
                  </time>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-8 w-8"
                      aria-label={`Delete update: ${u.title}`}
                      onClick={() => setPendingDelete({ id: u.id, title: u.title })}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
                <h3 className="font-medium">{u.title}</h3>
                <p className="whitespace-pre-line text-sm text-muted-foreground">{u.content}</p>
                {u.sourceUrl && <ExternalLink href={u.sourceUrl} className="text-xs" />}
              </div>
            </li>
          ))}
        </ol>
      )}
      {updates.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void updates.fetchNextPage()} disabled={updates.isFetchingNextPage}>
            {updates.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="Delete this update?"
        description={pendingDelete ? `"${pendingDelete.title}" is removed from the timeline. A scan won't add it back.` : ""}
        pending={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate({ id: pendingDelete.id })}
      />
    </section>
  );
}
