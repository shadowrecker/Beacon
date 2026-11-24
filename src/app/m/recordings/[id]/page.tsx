"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { format } from "date-fns";
import { ArrowLeft, Download, FileText, Share2, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { AudioPlayer } from "@/components/voice/audio-player";
import { InsightSummary } from "@/components/voice/insight-summary";
import { isProcessing, RecordingStatusBadge } from "@/components/voice/status";
import { TranscriptView } from "@/components/voice/transcript-view";
import { formatDuration } from "@/components/voice/upload";

export default function RecordingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);

  const rec = trpc.voice.get.useQuery({ id }, { refetchInterval: (q) => (isProcessing(q.state.data?.status) ? 4000 : false) });
  const audioReady = !!rec.data && rec.data.status !== "UPLOADING" && rec.data.status !== "RECORDING";
  const audio = trpc.voice.getAudioUrl.useQuery({ id }, { enabled: audioReady, staleTime: 4 * 60_000, retry: false });
  const remove = trpc.voice.deleteRecording.useMutation({
    onSuccess: async () => {
      toast.success("Recording deleted");
      await utils.voice.list.invalidate();
      router.push("/m/recordings");
    },
  });

  if (rec.isLoading) return <LoadingState rows={4} label="Loading recording" />;
  if (rec.isError || !rec.data) return <ErrorState message={rec.error?.message ?? "Recording not found"} onRetry={() => void rec.refetch()} />;
  const r = rec.data;
  const title = r.title || `Recording ${format(new Date(r.recordedAt), "PP p")}`;

  const share = async () => {
    const url = window.location.href;
    const text = r.insight?.summary ?? r.transcriptText?.slice(0, 500) ?? title;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ title, text, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast.success("Link copied. Teammates need access to this project to open it.");
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      toast.error("Couldn't share this recording");
    }
  };

  const freshAudioUrl = async () =>
    audio.data && new Date(audio.data.expiresAt).getTime() > Date.now() + 10_000 ? audio.data : (await audio.refetch()).data;

  const download = async () => {
    const res = await freshAudioUrl();
    if (!res) {
      toast.error("The audio isn't available");
      return;
    }
    const a = document.createElement("a");
    a.href = res.url;
    a.download = res.filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/m/recordings">
          <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
          Recordings
        </Link>
      </Button>

      <header className="space-y-2">
        <h1 className="text-xl font-bold">{title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <RecordingStatusBadge status={r.status} />
          <span>{format(new Date(r.recordedAt), "PP p")}</span>
          <span>· {formatDuration(r.duration)}</span>
          {r.project && <span>· {r.project.name}</span>}
        </div>
        {r.errorMessage && (
          <p role={r.status === "FAILED" ? "alert" : "status"} className={r.status === "FAILED" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {r.errorMessage}
          </p>
        )}
        {isProcessing(r.status) && <p className="text-sm text-muted-foreground">Transcribing and analyzing. This page updates automatically.</p>}
      </header>

      {audioReady && (
        <section aria-label="Audio" className="space-y-3">
          <AudioPlayer getUrl={async () => (await freshAudioUrl())?.url ?? null} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void download()} disabled={audio.isError && !audio.data}>
              <Download className="mr-1.5 h-4 w-4" aria-hidden />
              Download
            </Button>
            <Button variant="outline" size="sm" onClick={() => void share()}>
              <Share2 className="mr-1.5 h-4 w-4" aria-hidden />
              Share
            </Button>
            {r.documentId && r.project && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/projects/${r.project.id}/documents/${r.documentId}`}>
                  <FileText className="mr-1.5 h-4 w-4" aria-hidden />
                  Open document
                </Link>
              </Button>
            )}
            {r.canDelete && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirm(true)}>
                <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
                Delete
              </Button>
            )}
          </div>
        </section>
      )}

      {r.insight && (
        <section aria-labelledby="insights-heading" className="space-y-3 rounded-lg border p-4">
          <h2 id="insights-heading" className="font-semibold">
            Insights
          </h2>
          <InsightSummary insight={r.insight} />
        </section>
      )}

      <section aria-labelledby="transcript-heading" className="space-y-3">
        <h2 id="transcript-heading" className="font-semibold">
          Transcript
        </h2>
        <TranscriptView segments={r.segments} text={r.transcriptText} />
      </section>

      <Dialog open={confirm} onOpenChange={(o) => !remove.isPending && setConfirm(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this recording?</DialogTitle>
            <DialogDescription>The audio, transcript, insights and transcript document are permanently deleted.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate({ id: r.id })} disabled={remove.isPending}>
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
