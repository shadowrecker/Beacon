"use client";

import { Badge } from "@/components/ui/badge";

export interface InsightLike {
  summary: string;
  sentimentScore: number;
  themes: string[];
  keyPoints?: unknown;
  painPoints?: unknown;
  actionItems?: unknown;
  questions?: unknown;
  suggestedFollowUps?: unknown;
}

/** JSON columns hold string arrays; anything else is ignored. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

export function sentimentLabel(score: number): { label: string; variant: "positive" | "negative" | "neutral" | "medium" } {
  if (score >= 0.3) return { label: "Positive", variant: "positive" };
  if (score <= -0.3) return { label: "Negative", variant: "negative" };
  if (Math.abs(score) < 0.1) return { label: "Neutral", variant: "neutral" };
  return { label: score > 0 ? "Slightly positive" : "Slightly negative", variant: "medium" };
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-semibold">{title}</h4>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** Insight extracted from a recording: summary, sentiment, themes and lists. */
export function InsightSummary({ insight, compact }: { insight: InsightLike; compact?: boolean }) {
  const s = sentimentLabel(insight.sentimentScore);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={s.variant}>
          {s.label}
          <span className="sr-only"> sentiment ({insight.sentimentScore.toFixed(2)})</span>
        </Badge>
        {insight.themes.map((t) => (
          <Badge key={t} variant="outline">
            {t}
          </Badge>
        ))}
      </div>
      <p className="text-sm leading-relaxed">{insight.summary}</p>
      {!compact && (
        <div className="grid gap-4 sm:grid-cols-2">
          <ListSection title="Key points" items={strings(insight.keyPoints)} />
          <ListSection title="Pain points" items={strings(insight.painPoints)} />
          <ListSection title="Action items" items={strings(insight.actionItems)} />
          <ListSection title="Questions asked" items={strings(insight.questions)} />
          <ListSection title="Suggested follow-ups" items={strings(insight.suggestedFollowUps)} />
        </div>
      )}
    </div>
  );
}
