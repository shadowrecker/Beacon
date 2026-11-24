"use client";

import { useState } from "react";
import { Database, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type ImportRow = RouterOutputs["analytics"]["getImports"]["items"][number];

const SOURCE_LABEL: Record<string, string> = { CSV: "CSV", AMPLITUDE: "Amplitude", MIXPANEL: "Mixpanel", POSTHOG: "PostHog" };

export function ImportsList({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const [deleting, setDeleting] = useState<ImportRow | null>(null);
  const query = trpc.analytics.getImports.useInfiniteQuery(
    { projectId, limit: 10 },
    { getNextPageParam: (p) => p.nextCursor ?? undefined }
  );
  const remove = trpc.analytics.deleteImport.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.analytics.getImports.invalidate({ projectId }),
        utils.analytics.listSeries.invalidate({ projectId }),
        utils.analytics.getSeries.invalidate({ projectId }),
      ]);
      setDeleting(null);
      toast.success("Import deleted");
    },
  });
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Imported data</CardTitle>
        <CardDescription>The 10 most recent imports are used for charts and correlation.</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <LoadingState rows={2} label="Loading imports" />
        ) : query.isError ? (
          <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Database className="h-8 w-8" />}
            title="No usage data yet"
            description="Import a CSV of daily metrics or pull data from a connected Amplitude or Mixpanel project."
          />
        ) : (
          <div className="space-y-3">
            <ul className="divide-y rounded-lg border dark:divide-gray-800 dark:border-gray-800">
              {rows.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{SOURCE_LABEL[r.source] ?? r.source}</Badge>
                      <span className="text-sm">{new Date(r.importedAt).toLocaleString()}</span>
                    </div>
                    {r.summary ? (
                      <p className="text-sm text-muted-foreground">
                        {r.summary.points.toLocaleString()} points · {r.summary.series} series
                        {r.summary.start && r.summary.end ? ` · ${r.summary.start} to ${r.summary.end}` : ""}
                        {r.summary.skipped > 0 ? ` · ${r.summary.skipped} rows skipped` : ""}
                        {r.summary.truncated ? " · truncated at the import limit" : ""}
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">Summary unavailable</p>
                    )}
                  </div>
                  <Button variant="ghost" size="icon" aria-label="Delete this import" onClick={() => setDeleting(r)}>
                    <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
            {query.hasNextPage && (
              <div className="flex justify-center">
                <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                  {query.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this import?"
        description="Its data points are removed. Existing correlations stay until you run correlation again."
        confirmLabel="Delete import"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ projectId, importId: deleting.id })}
      />
    </Card>
  );
}
