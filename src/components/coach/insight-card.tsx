"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Check, X } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";

export type Insight = RouterOutputs["coach"]["getInsights"]["items"][number];

const TYPE_LABELS: Record<string, string> = {
  FRAMEWORK_SUGGESTION: "Framework",
  PROCESS_IMPROVEMENT: "Process",
  BEST_PRACTICE: "Best practice",
  WARNING: "Warning",
  NUDGE: "Nudge",
};

/** One coaching insight with "done" and "dismiss" actions (only the insight's owner sees it). */
export function InsightCard({ insight, showProject }: { insight: Insight; showProject?: boolean }) {
  const utils = trpc.useUtils();
  const done = async (msg: string) => {
    toast.success(msg);
    await utils.coach.getInsights.invalidate();
  };
  const action = trpc.coach.actionInsight.useMutation({ onSuccess: () => done("Marked as done") });
  const dismiss = trpc.coach.dismissInsight.useMutation({ onSuccess: () => done("Insight dismissed") });
  const open = insight.status === "NEW" || insight.status === "SEEN";
  const busy = action.isPending || dismiss.isPending;

  return (
    <Card className={insight.status === "NEW" ? "border-amber-400/70" : undefined}>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={insight.type === "WARNING" ? "high" : "secondary"}>{TYPE_LABELS[insight.type] ?? insight.type}</Badge>
          <Badge variant={insight.priority === "HIGH" ? "high" : insight.priority === "MEDIUM" ? "medium" : "low"}>{insight.priority.toLowerCase()} priority</Badge>
          {insight.framework && <Badge variant="outline">{insight.framework}</Badge>}
          {insight.status === "NEW" && <span className="text-xs font-semibold text-amber-600">New</span>}
          {!open && <Badge variant="outline">{insight.status === "ACTIONED" ? "Done" : "Dismissed"}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">{formatDistanceToNow(insight.createdAt, { addSuffix: true })}</span>
        </div>
        <div>
          <h3 className="font-semibold">{insight.title}</h3>
          {showProject && insight.project && (
            <Link href={`/coach?project=${insight.project.id}`} className="text-xs text-muted-foreground hover:underline">
              {insight.project.name}
            </Link>
          )}
        </div>
        <p className="text-sm">{insight.message}</p>
        {insight.actionItems.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {insight.actionItems.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        )}
        {insight.rationale && <p className="text-xs text-muted-foreground">Why: {insight.rationale}</p>}
        {open && (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => action.mutate({ insightId: insight.id })}>
              <Check className="mr-1.5 h-4 w-4" aria-hidden />
              Done
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => dismiss.mutate({ insightId: insight.id })}>
              <X className="mr-1.5 h-4 w-4" aria-hidden />
              Dismiss
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
