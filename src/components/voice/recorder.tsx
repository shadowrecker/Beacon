"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Pause, Play, RotateCcw, Square, Upload } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { formatDuration, uploadToPresignedPost } from "./upload";

/** Preferred formats, in order. iOS Safari only records audio/mp4. */
export const RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

const MIN_SECONDS = 1;
const MAX_SECONDS = 2 * 3600;

type Phase = "idle" | "requesting" | "recording" | "paused" | "recorded" | "uploading" | "finalizing";

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return "";
  return RECORDER_MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function extensionFor(mime: string): string {
  const base = mime.split(";")[0];
  if (base === "audio/mp4" || base === "audio/x-m4a" || base === "audio/aac") return "m4a";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mpeg") return "mp3";
  if (base === "audio/wav") return "wav";
  return "weba";
}

function isSupported(): boolean {
  return typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Records audio in the browser, then uploads it straight to storage via a
 * presigned POST and queues transcription. Every stream, timer, animation frame
 * and AudioContext is released on stop and on unmount.
 */
export function Recorder({ projectId, onUploaded, compact }: { projectId: string | undefined; onUploaded: (recordingId: string) => void; compact?: boolean }) {
  const [supported, setSupported] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const accumulatedRef = useRef(0);
  const recordedAtRef = useRef<Date>(new Date());
  const durationRef = useRef(0);
  const discardRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const createRecording = trpc.voice.createRecording.useMutation({ meta: { silent: true } });
  const finalizeRecording = trpc.voice.finalizeRecording.useMutation({ meta: { silent: true } });

  useEffect(() => setSupported(isSupported()), []);

  const currentElapsed = () => accumulatedRef.current + (startedAtRef.current ? (performance.now() - startedAtRef.current) / 1000 : 0);

  /** Release the microphone, meter and timers (idempotent). */
  const releaseResources = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
    setLevel(0);
  }, []);

  // Unmount: stop everything and drop any in-progress recording or upload.
  useEffect(() => {
    return () => {
      discardRef.current = true;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
      }
      abortRef.current?.abort();
      releaseResources();
    };
  }, [releaseResources]);

  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    durationRef.current = currentElapsed();
    startedAtRef.current = 0;
    accumulatedRef.current = durationRef.current;
    rec.stop();
  }, []);

  const start = async () => {
    setError(null);
    setBlob(null);
    setElapsed(0);
    setProgress(0);
    chunksRef.current = [];
    accumulatedRef.current = 0;
    discardRef.current = false;
    setPhase("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setPhase("idle");
      const name = (err as { name?: string }).name;
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access was blocked. Allow it in your browser settings and try again."
          : name === "NotFoundError"
            ? "No microphone was found."
            : "Couldn't start the microphone."
      );
      return;
    }
    streamRef.current = stream;

    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      releaseResources();
      setPhase("idle");
      setError("This browser can't record audio in a supported format.");
      return;
    }
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      releaseResources();
      recorderRef.current = null;
      if (discardRef.current) return;
      const type = rec.mimeType || mimeType || "audio/webm";
      const result = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      if (durationRef.current < MIN_SECONDS || result.size === 0) {
        setPhase("idle");
        setError("Recording too short. Record at least a second of audio.");
        return;
      }
      setBlob(result);
      setPhase("recorded");
    };

    // Level meter.
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += ((v - 128) / 128) ** 2;
          setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      }
    } catch {
      /* the meter is optional */
    }

    recordedAtRef.current = new Date();
    startedAtRef.current = performance.now();
    timerRef.current = setInterval(() => {
      const s = currentElapsed();
      setElapsed(s);
      if (s >= MAX_SECONDS) stop();
    }, 250);
    rec.start(1000);
    setPhase("recording");
  };

  const pause = () => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording" || typeof rec.pause !== "function") return;
    rec.pause();
    accumulatedRef.current = currentElapsed();
    startedAtRef.current = 0;
    setPhase("paused");
  };

  const resume = () => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    rec.resume();
    startedAtRef.current = performance.now();
    setPhase("recording");
  };

  const discard = () => {
    setBlob(null);
    setPreviewUrl(null);
    setTitle("");
    setElapsed(0);
    setPhase("idle");
  };

  const upload = async () => {
    if (!blob || !projectId) return;
    setError(null);
    setPhase("uploading");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const durationSec = Math.max(MIN_SECONDS, Math.round(durationRef.current));
      const created = await createRecording.mutateAsync({
        projectId,
        mimeType: blob.type || "audio/webm",
        durationSec,
        title: title.trim() || undefined,
        recordedAt: recordedAtRef.current,
        deviceInfo: {
          userAgent: navigator.userAgent.slice(0, 200),
          platform: (navigator.platform || "unknown").slice(0, 100),
        },
      });
      await uploadToPresignedPost(created.upload, blob, `recording.${extensionFor(blob.type)}`, setProgress, controller.signal);
      setPhase("finalizing");
      await finalizeRecording.mutateAsync({ id: created.recordingId });
      discard();
      onUploaded(created.recordingId);
    } catch (err) {
      if (discardRef.current) return;
      setPhase("recorded");
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
    } finally {
      abortRef.current = null;
    }
  };

  if (!supported) {
    return (
      <p role="alert" className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        This browser can&apos;t record audio. Use a recent version of Chrome, Edge, Firefox or Safari (iOS 14.3 or later).
      </p>
    );
  }

  const busy = phase === "uploading" || phase === "finalizing";
  const recording = phase === "recording" || phase === "paused";

  return (
    <div className={compact ? "space-y-4" : "space-y-6"}>
      <div className="flex flex-col items-center gap-4 py-2">
        <div className="font-mono text-4xl tabular-nums" aria-live="off" aria-label={`Elapsed ${formatDuration(elapsed)}`}>
          {formatDuration(elapsed)}
        </div>
        <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full rounded-full bg-primary transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
        <p className="sr-only" aria-live="polite">
          {phase === "recording" ? "Recording" : phase === "paused" ? "Paused" : phase === "recorded" ? "Recording finished" : ""}
        </p>

        {!recording && phase !== "recorded" && !busy && (
          <Button size="lg" className="h-16 w-16 rounded-full" onClick={() => void start()} disabled={phase === "requesting" || !projectId} aria-label="Start recording">
            {phase === "requesting" ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden /> : <Mic className="h-6 w-6" aria-hidden />}
          </Button>
        )}
        {recording && (
          <div className="flex items-center gap-3">
            {typeof MediaRecorder !== "undefined" && typeof MediaRecorder.prototype.pause === "function" && (
              <Button
                variant="outline"
                size="lg"
                className="h-14 w-14 rounded-full"
                onClick={phase === "paused" ? resume : pause}
                aria-label={phase === "paused" ? "Resume recording" : "Pause recording"}
              >
                {phase === "paused" ? <Play className="h-5 w-5" aria-hidden /> : <Pause className="h-5 w-5" aria-hidden />}
              </Button>
            )}
            <Button variant="destructive" size="lg" className="h-16 w-16 rounded-full" onClick={stop} aria-label="Stop recording">
              <Square className="h-6 w-6" aria-hidden />
            </Button>
          </div>
        )}
        {!projectId && phase === "idle" && <p className="text-sm text-muted-foreground">Choose a project to start recording.</p>}
      </div>

      {(phase === "recorded" || busy) && blob && (
        <div className="space-y-4 rounded-lg border p-4">
          {previewUrl && (
            <audio controls src={previewUrl} className="w-full">
              <track kind="captions" />
            </audio>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="recording-title">Title (optional)</Label>
            <Input id="recording-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} disabled={busy} placeholder="Call with Acme about onboarding" />
          </div>
          {busy && (
            <div className="space-y-1">
              <Progress value={Math.round(progress * 100)} aria-label="Upload progress" />
              <p className="text-xs text-muted-foreground">{phase === "finalizing" ? "Checking the upload…" : `Uploading… ${Math.round(progress * 100)}%`}</p>
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={discard} disabled={busy}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
              Discard
            </Button>
            <Button onClick={() => void upload()} disabled={busy || !projectId}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="mr-2 h-4 w-4" aria-hidden />}
              {error && phase === "recorded" ? "Retry upload" : "Save recording"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
