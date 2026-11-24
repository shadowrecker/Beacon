"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { FileText, Link2, MoreVertical, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import type { RouterInputs, RouterOutputs } from "@/lib/trpc";
import { trpc } from "@/lib/trpc/client";
import { formatBytes } from "@/lib/utils";
import { DOCUMENT_TYPE_LABEL, DOCUMENT_TYPES, type DocumentTypeValue } from "./document-types";
import { StatusBadge } from "./status-badge";

type DocumentItem = RouterOutputs["document"]["list"]["items"][number];
type Filters = Pick<RouterInputs["document"]["list"], "status" | "type" | "search" | "sort">;

const POLL_MS = 3_000;

function isActive(d: DocumentItem): boolean {
  return d.status === "PROCESSING" || (d.status === "PENDING" && !d.awaitingUpload);
}

const SOURCE_LABEL: Record<DocumentItem["source"], string> = {
  UPLOAD: "Upload",
  URL: "Web page",
  INTEGRATION: "Integration",
  VOICE: "Voice",
  QUICK_CAPTURE: "Quick capture",
};

function DocumentRow({ projectId, doc, canWrite }: { projectId: string; doc: DocumentItem; canWrite: boolean }) {
  const utils = trpc.useUtils();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => Promise.all([utils.document.list.invalidate({ projectId }), utils.project.getById.invalidate({ id: projectId })]);
  const retry = trpc.document.retry.useMutation({
    onSuccess: async () => {
      await invalidate();
      toast.success(`Reprocessing "${doc.title}"`);
    },
  });
  const remove = trpc.document.delete.useMutation({
    onSuccess: async () => {
      setConfirmDelete(false);
      await invalidate();
      toast.success(`Deleted "${doc.title}"`);
    },
  });

  return (
    <li className="flex items-start gap-3 p-4">
      <span className="mt-0.5 text-muted-foreground" aria-hidden>
        {doc.source === "URL" ? <Link2 className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/projects/${projectId}/documents/${doc.id}`} className="truncate font-medium hover:underline focus:underline focus:outline-none">
            {doc.title}
          </Link>
          <StatusBadge status={doc.status} awaitingUpload={doc.awaitingUpload} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {DOCUMENT_TYPE_LABEL[doc.type as DocumentTypeValue]} · {SOURCE_LABEL[doc.source]}
          {doc.fileSize ? ` · ${formatBytes(doc.fileSize, 1)}` : ""}
          {doc.status === "READY" ? ` · ${doc.chunkCount} ${doc.chunkCount === 1 ? "passage" : "passages"}` : ""} · added{" "}
          <time dateTime={new Date(doc.createdAt).toISOString()}>{formatDistanceToNow(new Date(doc.createdAt), { addSuffix: true })}</time>
        </p>
        {doc.status === "FAILED" && doc.errorMessage && (
          <p role="status" className="mt-1 text-xs text-destructive">
            {doc.errorMessage}
          </p>
        )}
      </div>
      {canWrite && (
        <div className="flex items-center gap-1">
          {doc.status === "FAILED" && !doc.awaitingUpload && (
            <Button variant="outline" size="sm" onClick={() => retry.mutate({ projectId, id: doc.id })} disabled={retry.isPending}>
              <RefreshCw className={retry.isPending ? "mr-1.5 h-3.5 w-3.5 animate-spin" : "mr-1.5 h-3.5 w-3.5"} aria-hidden />
              Retry
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${doc.title}`}>
                <MoreVertical className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/projects/${projectId}/documents/${doc.id}`}>View details</Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setConfirmDelete(true)} className="text-destructive focus:text-destructive">
                <Trash2 className="mr-2 h-4 w-4" aria-hidden /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete "${doc.title}"?`}
        description="The document, its uploaded file and its passages are deleted. Themes that cite it lose those citations. This can't be undone."
        confirmLabel="Delete document"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ projectId, id: doc.id })}
      />
    </li>
  );
}

export function DocumentList({ projectId, canWrite, emptyAction }: { projectId: string; canWrite: boolean; emptyAction?: React.ReactNode }) {
  const searchId = useId();
  const statusId = useId();
  const typeId = useId();
  const sortId = useId();
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>({ sort: "newest" });

  const query = trpc.document.list.useInfiniteQuery(
    { projectId, limit: 25, ...filters, search: filters.search || undefined },
    {
      getNextPageParam: (last) => last.nextCursor,
      refetchInterval: (q) => (q.state.data?.pages.some((p) => p.items.some(isActive)) ? POLL_MS : false),
    }
  );
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const filtered = Boolean(filters.status || filters.type || filters.search);

  return (
    <div className="space-y-4">
      <form
        role="search"
        className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters((f) => ({ ...f, search: search.trim() || undefined }));
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={searchId} className="text-xs">
            Search titles
          </Label>
          <Input id={searchId} value={search} onChange={(e) => setSearch(e.target.value)} maxLength={200} placeholder="Search and press Enter" />
        </div>
        <div className="space-y-1">
          <Label htmlFor={statusId} className="text-xs">
            Status
          </Label>
          <select
            id={statusId}
            className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            value={filters.status ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, status: (e.target.value || undefined) as Filters["status"] }))}
          >
            <option value="">All</option>
            <option value="READY">Ready</option>
            <option value="PROCESSING">Processing</option>
            <option value="PENDING">Queued</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={typeId} className="text-xs">
            Type
          </Label>
          <select
            id={typeId}
            className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            value={filters.type ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, type: (e.target.value || undefined) as Filters["type"] }))}
          >
            <option value="">All types</option>
            {DOCUMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={sortId} className="text-xs">
            Sort
          </Label>
          <select
            id={sortId}
            className="h-10 w-full rounded-lg border border-gray-300 bg-white px-2 text-sm dark:border-gray-700 dark:bg-gray-950"
            value={filters.sort ?? "newest"}
            onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value as Filters["sort"] }))}
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title (A–Z)</option>
          </select>
        </div>
      </form>

      {query.isLoading ? (
        <LoadingState rows={4} label="Loading documents" />
      ) : query.isError ? (
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState title="No matching documents" description="Try a different search or filter." />
        ) : (
          <EmptyState
            title="No documents yet"
            description="Upload interviews, call recordings, support tickets or notes, or import a web page. Beacon turns them into searchable, citable research."
            action={emptyAction}
          />
        )
      ) : (
        <>
          <ul className="divide-y rounded-lg border" aria-label="Documents">
            {items.map((doc) => (
              <DocumentRow key={doc.id} projectId={projectId} doc={doc} canWrite={canWrite} />
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
