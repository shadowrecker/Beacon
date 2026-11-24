"use client";

import { format } from "date-fns";
import { AlertTriangle } from "lucide-react";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { trpc } from "@/lib/trpc/client";
import { SYNTHESIS_TYPE_LABEL } from "./synthesis-types";
import { ThemeCard } from "./theme-card";

/** Themes and run summary for one synthesis. */
export function SynthesisResults({ projectId, synthesisId }: { projectId: string; synthesisId: string }) {
  const query = trpc.synthesis.getById.useQuery({ projectId, id: synthesisId });
  if (query.isLoading) return <LoadingState rows={4} label="Loading synthesis" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  const s = query.data!;

  if (s.status === "FAILED") {
    return (
      <div role="alert" className="rounded-lg border border-destructive/30 bg-red-50 p-4 text-sm text-red-800 dark:bg-red-950/20 dark:text-red-300">
        <p className="font-medium">This synthesis failed</p>
        <p className="mt-1">{s.errorMessage ?? "Something went wrong."}</p>
      </div>
    );
  }
  if (s.status !== "READY") return <p className="text-sm text-muted-foreground">This synthesis is still running.</p>;

  const summary = s.summary;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {SYNTHESIS_TYPE_LABEL[s.type]} · completed {s.completedAt ? format(new Date(s.completedAt), "PPp") : ""}
          {summary ? ` · ${summary.documentsAnalyzed} of ${summary.documentsConsidered} documents analyzed · ${summary.insightCount} insights` : ""}
        </p>
      </div>

      {summary && (summary.skippedDocuments.length > 0 || summary.partialDocuments.length > 0 || summary.documentsNotIncluded > 0) && (
        <div role="status" className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/20 dark:text-yellow-200">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden /> Some research wasn&apos;t fully included
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {summary.skippedDocuments.map((d) => (
              <li key={`s-${d.documentId}`}>
                <span className="font-medium">{d.title}</span> was skipped: {d.reason}
              </li>
            ))}
            {summary.partialDocuments.map((d) => (
              <li key={`p-${d.documentId}`}>
                <span className="font-medium">{d.title}</span>: only the first {d.analyzedChars.toLocaleString()} of {d.totalChars.toLocaleString()} characters were
                analyzed
              </li>
            ))}
            {summary.documentsNotIncluded > 0 && (
              <li>{summary.documentsNotIncluded} older documents were not included (each run analyzes the most recent documents).</li>
            )}
          </ul>
        </div>
      )}

      {s.themes.length === 0 ? (
        <EmptyState title="No themes found" description="The analyzed documents didn't contain enough recurring feedback to form themes. Add more research and run again." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {s.themes.map((t, i) => (
            <ThemeCard key={t.id} projectId={projectId} theme={t} rank={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
