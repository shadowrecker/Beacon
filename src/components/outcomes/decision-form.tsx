"use client";

/**
 * Record a product decision: what was decided, why (required), evidence links
 * (http/https only) and optionally the recommendation it relates to.
 */
import { useId, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeHref } from "@/components/ui/external-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";

const MAX_LINKS = 20;
const NONE = "__none__";

export function DecisionForm({ projectId }: { projectId: string }) {
  const uid = useId();
  const utils = trpc.useUtils();
  const [decision, setDecision] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [outcome, setOutcome] = useState("");
  const [links, setLinks] = useState<string[]>([""]);
  const [recommendationId, setRecommendationId] = useState(NONE);
  const [submitted, setSubmitted] = useState(false);

  const options = trpc.outcome.recommendationOptions.useQuery({ projectId, limit: 50 });

  const filledLinks = links.map((l) => l.trim()).filter(Boolean);
  const linkErrors = links.map((l) => (l.trim() && !safeHref(l.trim()) ? "Use a full http:// or https:// URL" : null));
  const errors = {
    decision: !decision.trim() ? "Describe the decision" : decision.length > 2_000 ? "At most 2,000 characters" : null,
    reasoning: !reasoning.trim() ? "Reasoning is required" : reasoning.length > 10_000 ? "At most 10,000 characters" : null,
    outcome: outcome.length > 2_000 ? "At most 2,000 characters" : null,
  };
  const invalid = Object.values(errors).some(Boolean) || linkErrors.some(Boolean);

  const add = trpc.outcome.addDecisionLog.useMutation({
    onSuccess: async () => {
      toast.success("Decision recorded");
      setDecision("");
      setReasoning("");
      setOutcome("");
      setLinks([""]);
      setRecommendationId(NONE);
      setSubmitted(false);
      await Promise.all([utils.outcome.getDecisionLog.invalidate({ projectId }), utils.outcome.getLearnings.invalidate({ projectId })]);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (invalid) return;
    add.mutate({
      projectId,
      decision: decision.trim(),
      reasoning: reasoning.trim(),
      evidenceLinks: filledLinks,
      recommendationId: recommendationId === NONE ? null : recommendationId,
      outcome: outcome.trim() || null,
    });
  };

  const show = (msg: string | null) => (submitted ? msg : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Record a decision</CardTitle>
        <CardDescription>Capture what was decided and why, so the team can revisit it when outcomes come in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={`${uid}-decision`}>Decision</Label>
            <Textarea
              id={`${uid}-decision`}
              value={decision}
              onChange={(e) => setDecision(e.target.value)}
              placeholder="e.g. Prioritize asynchronous CSV exports for Q3"
              className="min-h-[60px]"
              aria-invalid={Boolean(show(errors.decision))}
              aria-describedby={show(errors.decision) ? `${uid}-decision-error` : undefined}
              required
            />
            {show(errors.decision) && (
              <p id={`${uid}-decision-error`} className="text-sm text-destructive" role="alert">
                {errors.decision}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${uid}-reasoning`}>Reasoning (required)</Label>
            <Textarea
              id={`${uid}-reasoning`}
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value)}
              placeholder="What evidence and trade-offs led to this decision?"
              className="min-h-[120px]"
              aria-invalid={Boolean(show(errors.reasoning))}
              aria-describedby={show(errors.reasoning) ? `${uid}-reasoning-error` : undefined}
              required
            />
            {show(errors.reasoning) && (
              <p id={`${uid}-reasoning-error`} className="text-sm text-destructive" role="alert">
                {errors.reasoning}
              </p>
            )}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Evidence links (optional)</legend>
            {links.map((link, i) => (
              <div key={i} className="space-y-1">
                <div className="flex gap-2">
                  <Label htmlFor={`${uid}-link-${i}`} className="sr-only">
                    Evidence link {i + 1}
                  </Label>
                  <Input
                    id={`${uid}-link-${i}`}
                    type="url"
                    inputMode="url"
                    value={link}
                    onChange={(e) => setLinks((ls) => ls.map((l, j) => (j === i ? e.target.value : l)))}
                    placeholder="https://"
                    maxLength={2_000}
                    aria-invalid={Boolean(show(linkErrors[i]))}
                    aria-describedby={show(linkErrors[i]) ? `${uid}-link-${i}-error` : undefined}
                  />
                  {links.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove evidence link ${i + 1}`}>
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
                {show(linkErrors[i]) && (
                  <p id={`${uid}-link-${i}-error`} className="text-sm text-destructive" role="alert">
                    {linkErrors[i]}
                  </p>
                )}
              </div>
            ))}
            {links.length < MAX_LINKS && (
              <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setLinks((ls) => [...ls, ""])}>
                <Plus className="h-4 w-4" aria-hidden />
                Add link
              </Button>
            )}
          </fieldset>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${uid}-rec`}>Related recommendation (optional)</Label>
              <Select value={recommendationId} onValueChange={setRecommendationId} disabled={options.isLoading || options.isError}>
                <SelectTrigger id={`${uid}-rec`}>
                  <SelectValue placeholder={options.isLoading ? "Loading…" : "None"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {(options.data ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {options.isError && <p className="text-xs text-destructive">Couldn&apos;t load recommendations.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${uid}-outcome`}>Expected or actual outcome (optional)</Label>
              <Input
                id={`${uid}-outcome`}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                maxLength={2_000}
                aria-invalid={Boolean(show(errors.outcome))}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? "Saving…" : "Record decision"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
