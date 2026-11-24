"use client";

import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type RecordingStatus = "RECORDING" | "UPLOADING" | "TRANSCRIBING" | "ANALYZING" | "READY" | "FAILED";

const LABELS: Record<RecordingStatus, { label: string; variant: "positive" | "negative" | "neutral" | "low" }> = {
  RECORDING: { label: "Recording", variant: "neutral" },
  UPLOADING: { label: "Uploading", variant: "low" },
  TRANSCRIBING: { label: "Transcribing", variant: "low" },
  ANALYZING: { label: "Analyzing", variant: "low" },
  READY: { label: "Ready", variant: "positive" },
  FAILED: { label: "Failed", variant: "negative" },
};

export function isProcessing(status: RecordingStatus | string | undefined): boolean {
  return status === "UPLOADING" || status === "TRANSCRIBING" || status === "ANALYZING";
}

export function RecordingStatusBadge({ status }: { status: RecordingStatus }) {
  const s = LABELS[status];
  return (
    <Badge variant={s.variant} className="gap-1">
      {isProcessing(status) && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {s.label}
    </Badge>
  );
}
