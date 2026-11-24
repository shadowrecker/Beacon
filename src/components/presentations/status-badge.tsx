import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PresentationStatus } from "./theme";

const LABEL: Record<PresentationStatus, string> = { GENERATING: "Generating", READY: "Ready", FAILED: "Failed" };

export function PresentationStatusBadge({ status }: { status: PresentationStatus }) {
  const variant = status === "READY" ? "positive" : status === "FAILED" ? "destructive" : "secondary";
  return (
    <Badge variant={variant} className="gap-1">
      {status === "GENERATING" && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {LABEL[status]}
    </Badge>
  );
}
