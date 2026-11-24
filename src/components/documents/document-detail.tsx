"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { ArrowLeft, Download, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ExternalLink } from "@/components/ui/external-link";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import type { RouterOutputs } from "@/lib/trpc";
import { trpc } from "@/lib/trpc/client";
import { cn, formatBytes } from "@/lib/utils";
import { DOCUMENT_TYPE_LABEL, type DocumentTypeValue } from "./document-types";
import { StatusBadge } from "./status-badge";
import { CommentsToggle } from "@/components/collaboration/comments-toggle";

type Chunk = RouterOutputs["document"]["chunks"]["items"][number];

function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

function chunkLabel(c: Chunk): string {
  const meta = (c.metadata ?? {}) as { pages?: [number, number]; rows?: [number, number]; speakers?: string[]; startSec?: number };
  const parts: string[] = [`Passage ${c.position + 1}`];
  if (meta.pages) parts.push(meta.pages[0] === meta.pages[1] ? `page ${meta.pages[0]}` : `pages ${meta.pages[0]}–${meta.pages[1]}`);
  if (meta.rows) parts.push(meta.rows[0] === meta.rows[1] ? `row ${meta.rows[0]}` : `rows ${meta.rows[0]}–${meta.rows[1]}`);
  if (typeof meta.startSec === "number") parts.push(`from ${formatSeconds(meta.startSec)}`);
  if (meta.speakers?.length) parts.push(meta.speakers.join(", "));
  return parts.join(" · ");
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function ChunkViewer({ projectId, documentId, focus }: { projectId: string; documentId: string; focus: number | null }) {
  const [start, setStart] = useState(focus ?? 0);
  const focusRef = useRef<HTMLLIElement>(null);
  const query = trpc.document.chunks.useInfiniteQuery(
    { projectId, documentId, limit: 10 },
    { getNextPageParam: (last) => last.nextCursor, initialCursor: start }
  );
  const chunks = query.data?.pages.flatMap((p) => p.items) ?? [];

  useEffect(() => {
    if (focus !== null && focusRef.current) focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, query.data]);

  if (query.isLoading) return <LoadingState rows={3} label="Loading passages" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  if (chunks.length === 0) return <EmptyState title="No passages" description="Passages appear once the document has been processed." />;

  return (
    <div className="space-y-3">
      {start > 0 && (
        <Button variant="link" className="px-0" onClick={() => setStart(0)}>
          Show from the beginning
        </Button>
      )}
      <ol className="space-y-3" aria-label="Document passages">
        {chunks.map((c) => {
          const focused = c.position === focus;
          return (
            <li
              key={c.id}
              id={`passage-${c.position}`}
              ref={focused ? focusRef : undefined}
              className={cn("rounded-lg border p-4", focused && "border-blue-500 bg-blue-50/60 ring-1 ring-blue-500 dark:bg-blue-950/20")}
              aria-current={focused ? "true" : undefined}
            >
              <p className="mb-2 text-xs font-medium text-muted-foreground">{chunkLabel(c)}</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{c.content}</p>
            </li>
          );
        })}
      </ol>
      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? "Loading…" : "Load more passages"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function DocumentDetail({ projectId, documentId, focusPosition }: { projectId: string; documentId: string; focusPosition: number | null }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const project = trpc.project.getById.useQuery({ id: projectId });
  const doc = trpc.document.getById.useQuery(
    { projectId, id: documentId },
    { refetchInterval: (q) => (q.state.data && (q.state.data.status === "PROCESSING" || (q.state.data.status === "PENDING" && !q.state.data.awaitingUpload)) ? 3_000 : false) }
  );
  const wasActive = useRef(false);
  useEffect(() => {
    const status = doc.data?.status;
    if (status === "PENDING" || status === "PROCESSING") wasActive.current = true;
    else if (wasActive.current && (status === "READY" || status === "FAILED")) {
      wasActive.current = false;
      void utils.document.chunks.invalidate({ projectId, documentId });
      void utils.document.list.invalidate({ projectId });
    }
  }, [doc.data?.status, documentId, projectId, utils]);

  const download = trpc.document.getDownloadUrl.useMutation({
    onSuccess: ({ url }) => {
      window.location.assign(url);
    },
  });
  const retry = trpc.document.retry.useMutation({
    onSuccess: async () => {
      await utils.document.getById.invalidate({ projectId, id: documentId });
      toast.success("Reprocessing started");
    },
  });
  const remove = trpc.document.delete.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.document.list.invalidate({ projectId }), utils.project.getById.invalidate({ id: projectId })]);
      toast.success("Document deleted");
      router.push(`/projects/${projectId}/documents`);
    },
  });

  if (doc.isLoading) return <LoadingState rows={4} label="Loading document" />;
  if (doc.isError) {
    return doc.error.data?.code === "NOT_FOUND" ? (
      <EmptyState
        title="Document not found"
        description="It may have been deleted, or you may not have access to it."
        action={
          <Button asChild variant="outline">
            <Link href={`/projects/${projectId}/documents`}>Back to documents</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState message={doc.error.message} onRetry={() => void doc.refetch()} />
    );
  }
  const d = doc.data!;
  const canWrite = project.data?.permissions.write ?? false;
  const canExport = project.data ? project.data.role !== "VIEWER" : false;
  const info = d.processing ?? {};

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href={`/projects/${projectId}/documents`}>
            <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden /> All documents
          </Link>
        </Button>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="break-words text-2xl font-semibold">{d.title}</h2>
            <div className="mt-2">
              <StatusBadge status={d.status} awaitingUpload={d.awaitingUpload} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {d.hasFile && canExport && (
              <Button variant="outline" onClick={() => download.mutate({ projectId, id: d.id })} disabled={download.isPending}>
                <Download className="mr-2 h-4 w-4" aria-hidden /> Download original
              </Button>
            )}
            {canWrite && d.status === "FAILED" && !d.awaitingUpload && (
              <Button variant="outline" onClick={() => retry.mutate({ projectId, id: d.id })} disabled={retry.isPending}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Retry
              </Button>
            )}
            {canWrite && (
              <Button variant="outline" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden /> Delete
              </Button>
            )}
          </div>
        </div>
      </div>

      {d.status === "FAILED" && d.errorMessage && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950/20 dark:text-red-300">
          <p className="font-medium">Processing failed</p>
          <p className="mt-1">{d.errorMessage}</p>
        </div>
      )}
      {info.truncated === true && (
        <div role="status" className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/20 dark:text-yellow-200">
          This document is very long; only the first {Number(info.characters).toLocaleString()} of {Number(info.originalCharacters).toLocaleString()} characters
          were processed.
        </div>
      )}

      <Card className="p-5">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label="Type">{DOCUMENT_TYPE_LABEL[d.type as DocumentTypeValue]}</Fact>
          <Fact label="Source">{d.integrationProvider ? `Integration (${d.integrationProvider.toLowerCase()})` : d.source.replace("_", " ").toLowerCase()}</Fact>
          <Fact label="Added">{format(new Date(d.createdAt), "PPp")}</Fact>
          <Fact label="Processed">{d.processingCompletedAt ? format(new Date(d.processingCompletedAt), "PPp") : "—"}</Fact>
          {d.originalFilename && <Fact label="File">{d.originalFilename}</Fact>}
          {d.fileSize !== null && <Fact label="Size">{formatBytes(d.fileSize, 1)}</Fact>}
          {d.mimeType && <Fact label="Format">{d.mimeType}</Fact>}
          <Fact label="Passages">{d.chunkCount}</Fact>
          {typeof info.pages === "number" && <Fact label="Pages">{info.pages}</Fact>}
          {typeof info.rows === "number" && <Fact label="Rows">{info.rows}</Fact>}
          {typeof info.durationSec === "number" && <Fact label="Duration">{formatSeconds(info.durationSec)}</Fact>}
          {typeof info.turns === "number" && <Fact label="Speaker turns">{info.turns}</Fact>}
        </dl>
        {d.sourceUrl && (
          <p className="mt-4 text-sm">
            <span className="text-muted-foreground">Imported from </span>
            <ExternalLink href={d.sourceUrl} />
          </p>
        )}
        <CommentsToggle projectId={projectId} targetType="DOCUMENT" targetId={d.id} />
      </Card>

      <section aria-labelledby="passages-heading" className="space-y-3">
        <h3 id="passages-heading" className="text-lg font-semibold">
          Passages
        </h3>
        {d.status === "READY" ? (
          <ChunkViewer projectId={projectId} documentId={documentId} focus={focusPosition} />
        ) : (
          <p className="text-sm text-muted-foreground">Passages appear here once processing finishes.</p>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${d.title}"?`}
        description="The document, its uploaded file and its passages are deleted. This can't be undone."
        confirmLabel="Delete document"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ projectId, id: d.id })}
      />
    </div>
  );
}
