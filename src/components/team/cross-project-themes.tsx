"use client";

import { useState } from "react";
import Link from "next/link";
import { Layers } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";

const SENTIMENT_VARIANT = { POSITIVE: "positive", NEGATIVE: "negative", NEUTRAL: "neutral", MIXED: "medium" } as const;

export function CrossProjectThemes({ orgId }: { orgId: string }) {
  const [includeSingle, setIncludeSingle] = useState(false);
  const themes = trpc.team.crossProjectThemes.useInfiniteQuery(
    { orgId, minProjects: includeSingle ? 1 : 2, limit: 20 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const items = themes.data?.pages.flatMap((p) => p.items) ?? [];
  const meta = themes.data?.pages[0];

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Cross-project themes</CardTitle>
          <CardDescription>Themes from each project&apos;s latest synthesis, grouped by name.</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="include-single" checked={includeSingle} onCheckedChange={setIncludeSingle} />
          <Label htmlFor="include-single" className="text-sm font-normal">
            Include single-project themes
          </Label>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {themes.isLoading ? (
          <LoadingState rows={3} label="Loading themes" />
        ) : themes.isError ? (
          <ErrorState message={themes.error.message} onRetry={() => void themes.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Layers className="h-8 w-8" />}
            title={includeSingle ? "No themes yet" : "No themes shared across projects yet"}
            description={
              includeSingle
                ? "Run a synthesis in a project to see its themes here."
                : "When the same theme shows up in the latest synthesis of two or more projects, it appears here."
            }
          />
        ) : (
          <ul className="divide-y">
            {items.map((t) => (
              <li key={t.key} className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{t.name}</p>
                  <Badge variant="secondary">
                    {t.projectCount} {t.projectCount === 1 ? "project" : "projects"}
                  </Badge>
                  <Badge variant={SENTIMENT_VARIANT[t.sentiment]}>{t.sentiment.charAt(0) + t.sentiment.slice(1).toLowerCase()}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {t.citationCount} {t.citationCount === 1 ? "citation" : "citations"} · {Math.round(t.avgConfidence * 100)}% avg.
                    confidence
                  </span>
                </div>
                <ul className="flex flex-wrap gap-2" aria-label={`Projects with ${t.name}`}>
                  {t.projects.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/projects/${p.id}/synthesis`}
                        className="inline-flex rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      >
                        {p.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {themes.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void themes.fetchNextPage()} disabled={themes.isFetchingNextPage}>
              {themes.isFetchingNextPage ? "Loading…" : "Show more themes"}
            </Button>
          </div>
        )}
        {meta && meta.projectsSkipped > 0 && (
          <p className="text-xs text-muted-foreground">
            Based on the {meta.projectsConsidered} most recently updated projects; {meta.projectsSkipped} older{" "}
            {meta.projectsSkipped === 1 ? "project is" : "projects are"} not included.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
