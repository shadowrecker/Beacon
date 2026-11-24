"use client";

/**
 * Decision log: paginated decisions with reasoning, evidence links (rendered
 * only for http/https URLs) and a way to record what happened afterwards.
 */
import { useId, useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { ClipboardList, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ExternalLink } from "@/components/ui/external-link";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import type { DecisionItem } from "./labels";
import { CommentsToggle } from "@/components/collaboration/comments-toggle";

function OutcomeDialog({ projectId, decision }: { projectId: string; decision: DecisionItem }) {
  const uid = useId();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(decision.outcome ?? "");
  const save = trpc.outcome.updateDecisionOutcome.useMutation({
    onSuccess: async () => {
      toast.success("Outcome saved");
      setOpen(false);
      await utils.outcome.getDecisionLog.invalidate({ projectId });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.length > 2_000) return;
    save.mutate({ projectId, decisionId: decision.id, outcome: value.trim() || null });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setValue(decision.outcome ?? "");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <Pencil className="h-4 w-4" aria-hidden />
          {decision.outcome ? "Edit outcome" : "Record outcome"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Decision outcome</DialogTitle>
            <DialogDescription>What happened after this decision?</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${uid}-outcome`}>Outcome</Label>
            <Textarea id={`${uid}-outcome`} value={value} onChange={(e) => setValue(e.target.value)} maxLength={2_000} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DecisionCard({ projectId, decision: d, canEdit }: { projectId: string; decision: DecisionItem; canEdit: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <CardTitle className="whitespace-pre-wrap text-base leading-snug">{d.decision}</CardTitle>
          {canEdit && <OutcomeDialog projectId={projectId} decision={d} />}
        </div>
        <p className="text-xs text-muted-foreground">
          {d.user.name ?? d.user.email ?? "A team member"} · {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
          {d.recommendation && (
            <>
              {" · "}
              <Badge variant="outline" className="align-middle">
                {d.recommendation.title}
              </Badge>
            </>
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reasoning</h4>
          <p className="mt-1 whitespace-pre-wrap">{d.reasoning}</p>
        </div>
        {d.evidenceLinks.length > 0 && (
          <div>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Evidence</h4>
            <ul className="mt-1 space-y-1">
              {d.evidenceLinks.map((link, i) => (
                <li key={`${i}-${link}`}>
                  <ExternalLink href={link} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {d.outcome && (
          <div>
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outcome</h4>
            <p className="mt-1 whitespace-pre-wrap">{d.outcome}</p>
          </div>
        )}
        <CommentsToggle projectId={projectId} targetType="DECISION" targetId={d.id} />
      </CardContent>
    </Card>
  );
}

export function DecisionLog({ projectId, canEdit = true }: { projectId: string; canEdit?: boolean }) {
  const q = trpc.outcome.getDecisionLog.useInfiniteQuery({ projectId, limit: 20 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  if (q.isLoading) return <LoadingState rows={3} label="Loading decisions" />;
  if (q.isError) return <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />;
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardList className="h-8 w-8" />}
        title="No decisions recorded yet"
        description="Record product decisions with their reasoning and evidence to build an audit trail."
      />
    );
  }
  return (
    <div className="space-y-4">
      <ul className="space-y-4" aria-label="Decisions">
        {items.map((d) => (
          <li key={d.id}>
            <DecisionCard projectId={projectId} decision={d} canEdit={canEdit} />
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
            {q.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
