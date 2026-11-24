import { Badge } from "@/components/ui/badge";

const STYLES: Record<string, { label: string; className: string }> = {
  RUNNING: { label: "Running", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300" },
  SUCCESS: { label: "Succeeded", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
  PARTIAL_FAILURE: { label: "Partially failed", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300" },
  FAILED: { label: "Failed", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
};

export function RunStatusBadge({ status }: { status: string }) {
  const s = STYLES[status] ?? { label: status, className: "" };
  return (
    <Badge variant="outline" className={`border-transparent ${s.className}`}>
      {s.label}
    </Badge>
  );
}
