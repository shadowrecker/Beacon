import { cn } from "@/lib/utils";

export type Impact = "HIGH" | "MEDIUM" | "LOW";

const STYLES: Record<Impact, string> = {
  HIGH: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  MEDIUM: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  LOW: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

export function ImpactBadge({ impact }: { impact: Impact }) {
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", STYLES[impact])}>{impact.charAt(0) + impact.slice(1).toLowerCase()} impact</span>;
}
