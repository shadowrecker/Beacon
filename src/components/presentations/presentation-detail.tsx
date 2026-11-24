"use client";

/**
 * Presentation detail: status (polling only while GENERATING), slide
 * thumbnails, the selected slide with speaker notes, slide editing, PPTX/PDF
 * downloads (short-lived URLs fetched on click), regenerate and delete.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TRPCClientError } from "@trpc/client";
import { ChevronLeft, Download, Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AudienceBadge } from "./audience-badge";
import { SlideEditor } from "./slide-editor";
import { SlidePreview, SpeakerNotes } from "./slide-preview";
import { PresentationStatusBadge } from "./status-badge";
import { typeLabel } from "./theme";

const POLL_MS = 3_000;

function errorCode(err: unknown): string | undefined {
  return err instanceof TRPCClientError ? (err.data as { code?: string } | undefined)?.code : undefined;
}

export function PresentationDetail({ id }: { id: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState(1);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"regenerate" | "delete" | null>(null);

  const query = trpc.presentation.get.useQuery(
    { id },
    { refetchInterval: (q) => (q.state.data?.status === "GENERATING" ? POLL_MS : false) }
  );
  const p = query.data;
  const slides = useMemo(() => p?.slides ?? [], [p?.slides]);
  const slide = slides.find((s) => s.slideNumber === selected) ?? slides[0] ?? null;

  // Keep the selection valid when the deck changes (e.g. after regeneration).
  useEffect(() => {
    if (slides.length && !slides.some((s) => s.slideNumber === selected)) setSelected(slides[0].slideNumber);
  }, [slides, selected]);

  const invalidate = async () => {
    await Promise.all([utils.presentation.get.invalidate({ id }), utils.presentation.list.invalidate()]);
  };

  const regenerate = trpc.presentation.regenerate.useMutation({
    onSuccess: async () => {
      toast.success("Regenerating the presentation");
      setConfirm(null);
      setEditing(false);
      await invalidate();
    },
  });
  const remove = trpc.presentation.delete.useMutation({
    onSuccess: async () => {
      toast.success("Presentation deleted");
      const projectId = p?.projectId;
      setConfirm(null);
      await utils.presentation.list.invalidate();
      router.push(projectId ? `/presentations?project=${encodeURIComponent(projectId)}` : "/presentations");
    },
  });
  // Download URLs are short-lived: request one per click and navigate straight to it.
  const exportPptx = trpc.presentation.exportPptx.useMutation({ onSuccess: (r) => window.location.assign(r.url) });
  const exportPdf = trpc.presentation.exportPdf.useMutation({ onSuccess: (r) => window.location.assign(r.url) });

  if (query.isLoading) return <LoadingState rows={4} label="Loading presentation" />;
  if (query.isError) {
    if (errorCode(query.error) === "NOT_FOUND") {
      return (
        <EmptyState
          title="Presentation not found"
          description="It may have been deleted, or you don't have access to it."
          action={
            <Button asChild variant="outline">
              <Link href="/presentations">Back to presentations</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  }
  if (!p) return <LoadingState rows={4} />;

  const busy = regenerate.isPending || remove.isPending;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="gap-1">
        <Link href={`/presentations?project=${encodeURIComponent(p.projectId)}`}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Presentations
        </Link>
      </Button>

      <header className="flex flex-col gap-4 border-b border-gray-200 pb-6 dark:border-gray-800 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{p.title}</h1>
          <p className="text-sm text-muted-foreground">{p.projectName}</p>
          <div className="flex flex-wrap items-center gap-2">
            <PresentationStatusBadge status={p.status} />
            <AudienceBadge audience={p.audience} />
            <Badge variant="secondary">{typeLabel(p.type)}</Badge>
            {p.status === "READY" && <Badge variant="outline">{slides.length} slides</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.status === "READY" && (
            <>
              <Button variant="outline" className="gap-2" onClick={() => exportPptx.mutate({ id })} disabled={exportPptx.isPending}>
                {exportPptx.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                Download PPTX
              </Button>
              <Button variant="outline" className="gap-2" onClick={() => exportPdf.mutate({ id })} disabled={exportPdf.isPending}>
                {exportPdf.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                Download PDF
              </Button>
            </>
          )}
          {p.status !== "GENERATING" && (
            <Button variant="outline" className="gap-2" onClick={() => setConfirm("regenerate")} disabled={busy}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Regenerate
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => setConfirm("delete")} disabled={busy} aria-label="Delete presentation" title="Delete">
            <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
          </Button>
        </div>
      </header>

      {p.status === "GENERATING" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center" role="status" aria-live="polite">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" aria-hidden />
            <p className="font-medium">Generating slides…</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Beacon is drafting the deck from the latest synthesis, recommendations and outcomes, then rendering PPTX and PDF files. This page updates automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {p.status === "FAILED" && (
        <div role="alert" className="rounded-lg border border-destructive/30 p-6">
          <h2 className="font-semibold">Generation failed</h2>
          <p className="mt-1 text-sm text-muted-foreground">{p.errorMessage ?? "Something went wrong while generating this presentation."}</p>
          <Button className="mt-4 gap-2" onClick={() => regenerate.mutate({ id })} disabled={regenerate.isPending}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {regenerate.isPending ? "Starting…" : "Try again"}
          </Button>
        </div>
      )}

      {p.status === "READY" && slides.length === 0 && (
        <EmptyState title="This presentation has no slides" description="Regenerate it to draft new slides." />
      )}

      {p.status === "READY" && slide && (
        <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Slides" className="lg:max-h-[75vh] lg:overflow-y-auto lg:pr-1">
            <ol className="flex gap-3 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
              {slides.map((s) => {
                const active = s.slideNumber === slide.slideNumber;
                return (
                  <li key={s.slideNumber} className="w-40 flex-shrink-0 lg:w-full">
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(s.slideNumber);
                        setEditing(false);
                      }}
                      aria-current={active ? "true" : undefined}
                      aria-label={`Slide ${s.slideNumber}: ${s.title}`}
                      className={cn(
                        "block w-full rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                        active ? "ring-2 ring-blue-600" : "hover:bg-gray-100 dark:hover:bg-gray-900"
                      )}
                    >
                      <SlidePreview slide={s} themeColor={p.themeColor} compact />
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section aria-label={`Slide ${slide.slideNumber}`} className="min-w-0 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">
                Slide {slide.slideNumber} of {slides.length}
              </h2>
              {!editing && (
                <Button variant="outline" size="sm" className="gap-2" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  Edit slide
                </Button>
              )}
            </div>
            <SlidePreview slide={slide} themeColor={p.themeColor} />
            {editing ? (
              <Card>
                <CardContent className="pt-6">
                  <SlideEditor key={`${slide.slideNumber}-${p.revision}`} presentationId={p.id} slide={slide} onDone={() => setEditing(false)} />
                </CardContent>
              </Card>
            ) : (
              <SpeakerNotes notes={slide.speakerNotes} />
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={confirm === "regenerate"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Regenerate this presentation?"
        description="Beacon will draft new slides from the latest project data. Your slide edits will be replaced."
        confirmLabel="Regenerate"
        pending={regenerate.isPending}
        onConfirm={() => regenerate.mutate({ id })}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete presentation?"
        description={`"${p.title}" and its PPTX and PDF files will be permanently deleted.`}
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate({ id })}
      />
    </div>
  );
}
