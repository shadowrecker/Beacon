"use client";

/**
 * Feature brief for a recommendation, in a Radix dialog. Shows the stored brief
 * (recommendation.getById), or generates one on request; can regenerate and
 * export as Markdown.
 */
import { Download, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc/client";
import { briefToMarkdown, type Brief } from "./brief-markdown";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function BriefBody({ brief }: { brief: Brief }) {
  return (
    <div className="space-y-6 text-sm">
      <p className="text-muted-foreground">
        Expected impact: <span className="font-medium capitalize text-foreground">{brief.expectedImpact}</span> · Confidence:{" "}
        <span className="font-medium text-foreground">{Math.round(brief.confidenceLevel * 100)}%</span>
        {brief.impactedSegments.length > 0 && <> · Segments: {brief.impactedSegments.join(", ")}</>}
      </p>
      <Section title="Problem">
        <p className="whitespace-pre-wrap leading-relaxed">{brief.problemStatement}</p>
      </Section>
      {brief.userStories.length > 0 && (
        <Section title="User stories">
          <ul className="space-y-3">
            {brief.userStories.map((s, i) => (
              <li key={i} className="rounded-md border p-3">
                <p>
                  As a <strong>{s.persona}</strong>, I want to {s.action} so that {s.benefit}.
                </p>
                {s.acceptanceCriteria.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {s.acceptanceCriteria.map((c, j) => (
                      <li key={j}>{c}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {brief.requirements.length > 0 && (
        <Section title="Requirements">
          <ul className="space-y-2">
            {brief.requirements.map((r) => (
              <li key={r.id} className="rounded-md border p-3">
                <p>
                  <span className={r.priority === "P0" ? "mr-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-800 dark:bg-red-900/30 dark:text-red-300" : "mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold dark:bg-gray-800"}>
                    {r.id}
                  </span>
                  {r.description}
                </p>
                {r.acceptanceCriteria.length > 0 && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {r.acceptanceCriteria.map((c, j) => (
                      <li key={j}>{c}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {brief.successMetrics.length > 0 && (
        <Section title="Success metrics">
          <ul className="list-disc space-y-1 pl-5">
            {brief.successMetrics.map((m, i) => (
              <li key={i}>
                <strong>{m.metric}</strong>: {m.targetValue} <span className="text-muted-foreground">({m.measuringMethod})</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {brief.openQuestions.length > 0 && (
        <Section title="Open questions">
          <ul className="list-disc space-y-1 pl-5">
            {brief.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </Section>
      )}
      {brief.risks.length > 0 && (
        <Section title="Risks">
          <ul className="list-disc space-y-1 pl-5">
            {brief.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </Section>
      )}
      {brief.evidenceAppendix.map((section) => (
        <Section key={section.category} title={`Evidence: ${section.category}`}>
          <ul className="space-y-2">
            {section.quotes.map((q) => (
              <li key={`${q.chunkId}-${q.text.slice(0, 20)}`} className="border-l-2 border-blue-400 pl-3">
                <p className="italic">&ldquo;{q.text}&rdquo;</p>
                <p className="text-xs text-muted-foreground">{q.context}</p>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}

function downloadMarkdown(brief: Brief) {
  const blob = new Blob([briefToMarkdown(brief)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${brief.title.replace(/[^\w.-]+/g, "_").slice(0, 80) || "brief"}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

export function BriefViewer({
  projectId,
  recommendation,
  canGenerate,
  open,
  onOpenChange,
}: {
  projectId: string;
  recommendation: { id: string; title: string; hasBrief: boolean };
  canGenerate: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const detail = trpc.recommendation.getById.useQuery({ projectId, id: recommendation.id }, { enabled: open && recommendation.hasBrief });
  const generate = trpc.recommendation.generateBrief.useMutation({
    onSuccess: async (res) => {
      await Promise.all([utils.recommendation.getById.invalidate({ projectId, id: recommendation.id }), utils.recommendation.list.invalidate({ projectId })]);
      if (res.generated) toast.success("Brief ready");
    },
  });
  const brief: Brief | null = generate.data?.brief ?? detail.data?.brief ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{brief?.title ?? recommendation.title}</DialogTitle>
          <DialogDescription>Feature brief generated from this recommendation and its customer evidence.</DialogDescription>
        </DialogHeader>

        {generate.isPending ? (
          <div role="status" className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Writing the brief…
          </div>
        ) : brief ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => downloadMarkdown(brief)}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden /> Export Markdown
              </Button>
              {canGenerate && (
                <Button variant="outline" size="sm" onClick={() => generate.mutate({ projectId, id: recommendation.id, regenerate: true })}>
                  <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden /> Regenerate
                </Button>
              )}
            </div>
            <BriefBody brief={brief} />
          </>
        ) : recommendation.hasBrief && detail.isLoading ? (
          <LoadingState rows={4} label="Loading brief" />
        ) : recommendation.hasBrief && detail.isError ? (
          <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
        ) : (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="max-w-md text-sm text-muted-foreground">
              A brief turns this recommendation into a problem statement, user stories, requirements, success metrics and open questions, with the evidence
              attached.
            </p>
            {canGenerate ? (
              <Button onClick={() => generate.mutate({ projectId, id: recommendation.id })}>
                <Sparkles className="mr-2 h-4 w-4" aria-hidden /> Generate brief
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">No brief has been generated yet.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
