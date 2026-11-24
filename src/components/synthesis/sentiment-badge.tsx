import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  POSITIVE: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  NEGATIVE: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  NEUTRAL: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  MIXED: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

export function SentimentBadge({ sentiment }: { sentiment: string }) {
  const label = sentiment.charAt(0) + sentiment.slice(1).toLowerCase();
  return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STYLES[sentiment] ?? STYLES.NEUTRAL)}>{label}</span>;
}
