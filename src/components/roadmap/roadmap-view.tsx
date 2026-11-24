"use client";

import { useState } from "react";
import { ListTodo, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { ItemDialog, type RoadmapItem } from "./item-dialog";
import { ITEM_STATUSES, PRIORITY_VARIANT, SOURCE_LABEL, STATUS_LABEL, STATUS_VARIANT, type ItemStatus } from "./labels";

interface RoadmapViewProps {
  projectId: string;
  roadmapId: string;
}

export function RoadmapView({ projectId, roadmapId }: RoadmapViewProps) {
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<ItemStatus | "ALL">("ALL");
  const [editing, setEditing] = useState<RoadmapItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<RoadmapItem | null>(null);

  const query = trpc.roadmap.get.useInfiniteQuery(
    { projectId, roadmapId, limit: 50, ...(status === "ALL" ? {} : { status }) },
    { getNextPageParam: (p) => p.nextCursor ?? undefined }
  );
  const remove = trpc.roadmap.deleteItem.useMutation({
    onSuccess: async () => {
      await utils.roadmap.get.invalidate({ projectId, roadmapId });
      await utils.roadmap.list.invalidate({ projectId });
      setDeleting(null);
      toast.success("Item deleted");
    },
  });

  const first = query.data?.pages[0];
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const info = first?.roadmap;
  const lastImport = info?.lastImport as { at?: string; created?: number; updated?: number; skipped?: number } | null | undefined;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg">{info?.name ?? "Roadmap items"}</CardTitle>
            {info && (
              <p className="text-sm text-muted-foreground">
                {info.itemCount} item{info.itemCount === 1 ? "" : "s"} · {SOURCE_LABEL[info.importSource ?? info.source] ?? info.source}
                {lastImport?.at && ` · last imported ${new Date(lastImport.at).toLocaleString()}`}
              </p>
            )}
          </div>
          <Button onClick={() => setAdding(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden />
            Add item
          </Button>
        </div>
        {info && (
          <ul className="flex flex-wrap gap-2" aria-label="Items by status">
            {ITEM_STATUSES.map((s) => (
              <li key={s}>
                <Badge variant={STATUS_VARIANT[s]}>
                  {STATUS_LABEL[s]}: {info.statusCounts[s]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="w-full max-w-xs space-y-2">
          <Label htmlFor="roadmap-status-filter">Filter by status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as ItemStatus | "ALL")}>
            <SelectTrigger id="roadmap-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {ITEM_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <LoadingState rows={4} label="Loading roadmap items" />
        ) : query.isError ? (
          <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ListTodo className="h-8 w-8" />}
            title={status === "ALL" ? "No items on this roadmap" : `No ${STATUS_LABEL[status].toLowerCase()} items`}
            description={status === "ALL" ? "Add items by hand or import them from a CSV, Linear, Jira or Notion." : undefined}
            action={status === "ALL" ? <Button onClick={() => setAdding(true)}>Add item</Button> : undefined}
          />
        ) : (
          <div className="space-y-3">
            <ul className="divide-y rounded-lg border dark:divide-gray-800 dark:border-gray-800">
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-gray-900 dark:text-white">{item.title}</p>
                      <Badge variant={PRIORITY_VARIANT[item.priority]}>{item.priority}</Badge>
                      <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                      {item.quarter && <Badge variant="outline">{item.quarter}</Badge>}
                    </div>
                    {item.description && <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{item.description}</p>}
                    {item.externalId && !item.externalId.startsWith("csv:") && (
                      <p className="text-xs text-muted-foreground">External ID: {item.externalId}</p>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 gap-1">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${item.title}`} onClick={() => setEditing(item)}>
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Delete ${item.title}`} onClick={() => setDeleting(item)}>
                      <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
                    </Button>
                  </div>
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

      <ItemDialog
        projectId={projectId}
        roadmapId={roadmapId}
        item={editing}
        open={adding || editing !== null}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false);
            setEditing(null);
          }
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this item?"
        description={deleting ? `"${deleting.title}" will be removed from the roadmap.` : undefined}
        confirmLabel="Delete item"
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ projectId, itemId: deleting.id })}
      />
    </Card>
  );
}
