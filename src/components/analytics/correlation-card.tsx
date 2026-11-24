import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { RouterOutputs } from "@/lib/trpc";

export type Correlation = RouterOutputs["analytics"]["getCorrelations"]["items"][number];

const DIRECTION = {
  positive: { variant: "positive", label: "Positive", Icon: TrendingUp },
  negative: { variant: "negative", label: "Negative", Icon: TrendingDown },
  neutral: { variant: "neutral", label: "Neutral", Icon: Minus },
} as const;

function strength(score: number): string {
  const a = Math.abs(score);
  if (a >= 0.7) return "strong";
  if (a >= 0.5) return "moderate";
  return "weak";
}

export function CorrelationCard({ correlation: c }: { correlation: Correlation }) {
  const dir = DIRECTION[c.direction as keyof typeof DIRECTION] ?? DIRECTION.neutral;
  const score = `${c.correlationScore > 0 ? "+" : ""}${c.correlationScore.toFixed(2)}`;
  return (
    <article className="rounded-lg border p-4 dark:border-gray-800" aria-label={`${c.theme.name} and ${c.featureName}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="font-medium text-gray-900 dark:text-white">{c.theme.name}</h3>
          <p className="text-sm text-muted-foreground">
            {c.featureName} · {c.usageMetric}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={dir.variant}>
            <dir.Icon className="mr-1 h-3 w-3" aria-hidden />
            {dir.label}
          </Badge>
          <span className="font-mono text-sm font-semibold" title="Pearson correlation coefficient">
            r = {score}
          </span>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {strength(c.correlationScore)} correlation · updated {new Date(c.updatedAt).toLocaleDateString()}
      </p>
      <p className="mt-3 text-sm leading-relaxed text-gray-700 dark:text-gray-300">{c.insight}</p>
    </article>
  );
}
