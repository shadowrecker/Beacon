import { AlertCircle, CheckCircle2, Clock, Loader2, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProcessingStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";

const STYLES: Record<ProcessingStatus | "UPLOADING", { label: string; className: string; icon: typeof Clock; spin?: boolean }> = {
  UPLOADING: { label: "Waiting for upload", className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", icon: UploadCloud },
  PENDING: { label: "Queued", className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", icon: Clock },
  PROCESSING: { label: "Processing", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300", icon: Loader2, spin: true },
  READY: { label: "Ready", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300", icon: CheckCircle2 },
  FAILED: { label: "Failed", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300", icon: AlertCircle },
};

/** Status pill for documents, syntheses and job runs. */
export function StatusBadge({ status, awaitingUpload = false, className }: { status: ProcessingStatus; awaitingUpload?: boolean; className?: string }) {
  const style = STYLES[awaitingUpload && status === "PENDING" ? "UPLOADING" : status];
  const Icon = style.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", style.className, className)}>
      <Icon className={cn("h-3 w-3", style.spin && "animate-spin")} aria-hidden />
      {style.label}
    </span>
  );
}

export function isTerminal(status: ProcessingStatus): boolean {
  return status === "READY" || status === "FAILED";
}
