"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CitationList } from "@/components/query/citation-list";
import type { RouterOutputs } from "@/lib/trpc";
import { SentimentBadge } from "./sentiment-badge";
import { ThemeEvidenceDialog } from "./theme-evidence-dialog";
import { CommentsToggle } from "@/components/collaboration/comments-toggle";

export type ThemeView = RouterOutputs["synthesis"]["getById"]["themes"][number];

const SEVERITY_STYLE: Record<string, string> = {
  high: "text-red-700 dark:text-red-400",
  medium: "text-amber-700 dark:text-amber-400",
  low: "text-gray-600 dark:text-gray-400",
};

export function ThemeCard({ projectId, theme, rank }: { projectId: string; theme: ThemeView; rank: number }) {
  const [showAll, setShowAll] = useState(false);
  const confidence = Math.round(theme.confidenceScore * 100);
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold leading-snug">
          <span className="mr-2 text-muted-foreground">{rank}.</span>
          {theme.name}
        </h3>
        <SentimentBadge sentiment={theme.sentiment} />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{theme.description}</p>

      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Confidence</dt>
          <dd className="font-medium">
            <span className="sr-only">{confidence} percent</span>
            <span aria-hidden>{confidence}%</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800" aria-hidden>
              <span className="block h-full bg-blue-500" style={{ width: `${confidence}%` }} />
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Documents</dt>
          <dd className="font-medium">{theme.frequency ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Severity</dt>
          <dd className={`font-medium capitalize ${theme.severity ? SEVERITY_STYLE[theme.severity] : ""}`}>{theme.severity ?? "—"}</dd>
        </div>
      </dl>

      {(theme.productAreas.length > 0 || theme.segments.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {theme.productAreas.map((a) => (
            <span key={`a-${a}`} className="rounded-md bg-blue-50 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
              {a}
            </span>
          ))}
          {theme.segments.map((s) => (
            <span key={`s-${s}`} className="rounded-md bg-purple-50 px-2 py-0.5 text-xs text-purple-800 dark:bg-purple-950/40 dark:text-purple-300">
              {s}
            </span>
          ))}
        </div>
      )}

      <CitationList projectId={projectId} citations={theme.topQuotes} />
      {theme.citationCount > theme.topQuotes.length && (
        <Button variant="link" className="mt-2 self-start px-0" onClick={() => setShowAll(true)}>
          View all {theme.citationCount} quotes
        </Button>
      )}
      {theme.citationCount === 0 && <p className="mt-3 text-xs text-muted-foreground">No verbatim quotes could be verified for this theme.</p>}
      <ThemeEvidenceDialog projectId={projectId} theme={theme} open={showAll} onOpenChange={setShowAll} />
      <CommentsToggle projectId={projectId} targetType="THEME" targetId={theme.id} />
    </Card>
  );
}
