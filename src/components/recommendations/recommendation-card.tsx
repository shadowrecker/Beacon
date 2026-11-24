"use client";

import { useState } from "react";
import { Check, FileText, RotateCcw, Rocket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { CitationList } from "@/components/query/citation-list";
import type { RouterOutputs } from "@/lib/trpc";
import { trpc } from "@/lib/trpc/client";
import { ExportDialog } from "@/components/handoff/export-dialog";
import { BriefViewer } from "./brief-viewer";
import { ImpactBadge } from "./impact-badge";
import { CommentsToggle } from "@/components/collaboration/comments-toggle";

export type RecommendationItem = RouterOutputs["recommendation"]["list"]["items"][number];
type Status = RecommendationItem["status"];

const STATUS_LABEL: Record<Status, string> = { DRAFT: "Draft", ACCEPTED: "Accepted", REJECTED: "Rejected", IMPLEMENTED: "Implemented" };
const STATUS_STYLE: Record<Status, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  ACCEPTED: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  REJECTED: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  IMPLEMENTED: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

export function RecommendationCard({
  projectId,
  rec,
  canWrite,
  canRunAI,
}: {
  projectId: string;
  rec: RecommendationItem;
  canWrite: boolean;
  canRunAI: boolean;
}) {
  const utils = trpc.useUtils();
  const [briefOpen, setBriefOpen] = useState(false);
  const update = trpc.recommendation.updateStatus.useMutation({
    onSuccess: async (res) => {
      await Promise.all([utils.recommendation.list.invalidate({ projectId }), utils.project.getById.invalidate({ id: projectId })]);
      toast.success(`Marked as ${STATUS_LABEL[res.status].toLowerCase()}`);
    },
  });
  const setStatus = (status: Status) => update.mutate({ projectId, id: rec.id, status });
  const confidence = Math.round(rec.confidence * 100);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-base font-semibold leading-snug">{rec.title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <ImpactBadge impact={rec.impact} />
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[rec.status]}`}>{STATUS_LABEL[rec.status]}</span>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{rec.description}</p>

      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Confidence</dt>
          <dd className="font-medium">{confidence}%</dd>
        </div>
        {rec.segments.length > 0 && (
          <div>
            <dt className="text-xs text-muted-foreground">Segments</dt>
            <dd className="flex flex-wrap gap-1">
              {rec.segments.map((s) => (
                <span key={s} className="rounded-md bg-purple-50 px-2 py-0.5 text-xs text-purple-800 dark:bg-purple-950/40 dark:text-purple-300">
                  {s}
                </span>
              ))}
            </dd>
          </div>
        )}
        {rec.evidence.themes.length > 0 && (
          <div>
            <dt className="text-xs text-muted-foreground">Based on</dt>
            <dd>{rec.evidence.themes.map((t) => t.name).join("; ")}</dd>
          </div>
        )}
      </dl>
      {rec.evidence.rationale && <p className="mt-3 text-sm">{rec.evidence.rationale}</p>}
      <CitationList projectId={projectId} citations={rec.evidence.quotes} />
      {rec.evidence.quoteCount > rec.evidence.quotes.length && (
        <p className="mt-1 text-xs text-muted-foreground">+{rec.evidence.quoteCount - rec.evidence.quotes.length} more quotes in the brief</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
        {canWrite && rec.status !== "ACCEPTED" && rec.status !== "IMPLEMENTED" && (
          <Button size="sm" onClick={() => setStatus("ACCEPTED")} disabled={update.isPending}>
            <Check className="mr-1.5 h-4 w-4" aria-hidden /> Accept
          </Button>
        )}
        {canWrite && rec.status === "ACCEPTED" && (
          <Button size="sm" onClick={() => setStatus("IMPLEMENTED")} disabled={update.isPending}>
            <Rocket className="mr-1.5 h-4 w-4" aria-hidden /> Mark implemented
          </Button>
        )}
        {canWrite && rec.status !== "REJECTED" && rec.status !== "IMPLEMENTED" && (
          <Button size="sm" variant="outline" onClick={() => setStatus("REJECTED")} disabled={update.isPending}>
            <X className="mr-1.5 h-4 w-4" aria-hidden /> Reject
          </Button>
        )}
        {canWrite && rec.status !== "DRAFT" && (
          <Button size="sm" variant="ghost" onClick={() => setStatus("DRAFT")} disabled={update.isPending}>
            <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden /> Back to draft
          </Button>
        )}
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setBriefOpen(true)} disabled={!rec.hasBrief && !canRunAI}>
          <FileText className="mr-1.5 h-4 w-4" aria-hidden /> {rec.hasBrief ? "View brief" : "Create brief"}
        </Button>
        <ExportDialog projectId={projectId} recommendationId={rec.id} recommendationTitle={rec.title} />
      </div>
      <BriefViewer projectId={projectId} recommendation={rec} canGenerate={canRunAI} open={briefOpen} onOpenChange={setBriefOpen} />
      <CommentsToggle projectId={projectId} targetType="RECOMMENDATION" targetId={rec.id} />
    </Card>
  );
}
