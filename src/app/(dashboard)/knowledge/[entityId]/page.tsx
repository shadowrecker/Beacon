"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { format } from "date-fns";
import { ChevronLeft, FileText, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { EntityNeighborhood } from "@/components/knowledge/entity-neighborhood";
import { EntityRelations } from "@/components/knowledge/entity-relations";
import { EntityTypeBadge } from "@/components/knowledge/entity-card";

export default function EntityPage() {
  const { entityId } = useParams<{ entityId: string }>();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const entity = trpc.knowledge.getEntity.useQuery({ entityId });
  const remove = trpc.knowledge.deleteEntity.useMutation({
    onSuccess: async () => {
      toast.success("Entity deleted");
      setConfirmDelete(false);
      await Promise.all([utils.knowledge.listEntities.invalidate(), utils.knowledge.getStats.invalidate(), utils.knowledge.getTopHubs.invalidate()]);
      router.push("/knowledge");
    },
  });

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link href="/knowledge">
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
          Knowledge graph
        </Link>
      </Button>

      {entity.isLoading ? (
        <LoadingState rows={4} label="Loading entity" />
      ) : entity.isError ? (
        <ErrorState message={entity.error.message} onRetry={() => void entity.refetch()} />
      ) : !entity.data ? null : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-bold">{entity.data.name}</h1>
                <EntityTypeBadge type={entity.data.type} />
              </div>
              {entity.data.description && <p className="max-w-3xl text-muted-foreground">{entity.data.description}</p>}
              <p className="text-sm text-muted-foreground">
                {entity.data.mentionCount} mentions · {entity.data.relationCount} relations · first seen {format(entity.data.firstSeenAt, "PP")} · last seen {format(entity.data.lastSeenAt, "PP")}
              </p>
              {entity.data.aliases.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Also known as</span>
                  {entity.data.aliases.map((a) => (
                    <Badge key={a} variant="secondary">
                      {a}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            {entity.data.permissions.canDelete && (
              <Button variant="outline" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                Delete entity
              </Button>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-6 lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Connections</CardTitle>
                </CardHeader>
                <CardContent>
                  <EntityNeighborhood entityId={entity.data.id} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Relations and evidence</CardTitle>
                </CardHeader>
                <CardContent>
                  <EntityRelations entityId={entity.data.id} />
                </CardContent>
              </Card>
            </div>
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Mentions</CardTitle>
                </CardHeader>
                <CardContent>
                  {entity.data.mentions.length === 0 ? (
                    <EmptyState icon={<FileText className="h-8 w-8" />} title="No mentions available" description="The documents that mentioned this entity may have been removed." />
                  ) : (
                    <ul className="space-y-3">
                      {entity.data.mentions.map((m) => (
                        <li key={m.chunkId} className="space-y-1 text-sm">
                          <p className="text-muted-foreground">{m.excerpt}</p>
                          <Link href={`/projects/${m.projectId}/documents/${m.documentId}`} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400">
                            <FileText className="h-3 w-3" aria-hidden />
                            {m.documentTitle}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Projects</CardTitle>
                </CardHeader>
                <CardContent>
                  {entity.data.projects.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Not linked to a project.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {entity.data.projects.map((p) => (
                        <li key={p.id}>
                          <Link href={`/projects/${p.id}`} className="hover:underline">
                            {p.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete “{entity.data.name}”?</DialogTitle>
                <DialogDescription>This removes the entity and all of its relations from the workspace graph. It will be re-created if new feedback mentions it.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ entityId: entity.data!.id })}>
                  {remove.isPending ? "Deleting…" : "Delete"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
