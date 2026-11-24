"use client";

/**
 * Track (new) or update (existing) the outcome of a recommendation: status,
 * metric name, baseline / current / target values and notes. Empty numeric
 * fields are saved as "not recorded".
 */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { OUTCOME_STATUS_OPTIONS, type OutcomeItem, type OutcomeStatus } from "./labels";

interface FormState {
  recommendationId: string;
  status: OutcomeStatus;
  metricName: string;
  baselineValue: string;
  currentValue: string;
  targetValue: string;
  notes: string;
}

const toText = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

function parseNumber(raw: string): { value: number | null; error: string | null } {
  const t = raw.trim();
  if (!t) return { value: null, error: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { value: null, error: "Enter a number" };
  if (Math.abs(n) > 1e12) return { value: null, error: "Value is too large" };
  return { value: n, error: null };
}

export function OutcomeFormDialog({
  projectId,
  outcome,
  trigger,
}: {
  projectId: string;
  /** Existing outcome to update; omit to start tracking a recommendation. */
  outcome?: OutcomeItem;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        {open && <OutcomeForm projectId={projectId} outcome={outcome} onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function OutcomeForm({ projectId, outcome, onDone }: { projectId: string; outcome?: OutcomeItem; onDone: () => void }) {
  const uid = useId();
  const utils = trpc.useUtils();
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState<FormState>({
    recommendationId: outcome?.recommendation.id ?? "",
    status: outcome?.status ?? "SHIPPED",
    metricName: outcome?.metricName ?? "",
    baselineValue: toText(outcome?.baselineValue),
    currentValue: toText(outcome?.currentValue),
    targetValue: toText(outcome?.targetValue),
    notes: outcome?.notes ?? "",
  });
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const options = trpc.outcome.recommendationOptions.useQuery(
    { projectId, untrackedOnly: true, limit: 50 },
    { enabled: !outcome }
  );

  const baseline = parseNumber(form.baselineValue);
  const current = parseNumber(form.currentValue);
  const target = parseNumber(form.targetValue);
  const errors = {
    recommendation: !outcome && !form.recommendationId ? "Choose a recommendation" : null,
    metricName: form.metricName.trim().length > 120 ? "At most 120 characters" : null,
    baseline: baseline.error,
    current: current.error,
    target: target.error,
    notes: form.notes.length > 5_000 ? "At most 5,000 characters" : null,
  };
  const invalid = Object.values(errors).some(Boolean);

  const done = async (message: string) => {
    toast.success(message);
    await Promise.all([
      utils.outcome.getOutcomes.invalidate({ projectId }),
      utils.outcome.getLearnings.invalidate({ projectId }),
      utils.outcome.recommendationOptions.invalidate({ projectId }),
    ]);
    onDone();
  };
  const track = trpc.outcome.track.useMutation({ onSuccess: () => done("Outcome tracking started") });
  const update = trpc.outcome.update.useMutation({ onSuccess: () => done("Outcome updated") });
  const pending = track.isPending || update.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (invalid) return;
    const fields = {
      status: form.status,
      metricName: form.metricName.trim() || null,
      baselineValue: baseline.value,
      currentValue: current.value,
      targetValue: target.value,
      notes: form.notes.trim() || null,
    };
    if (outcome) update.mutate({ projectId, outcomeId: outcome.id, ...fields });
    else track.mutate({ projectId, recommendationId: form.recommendationId, ...fields });
  };

  const err = (key: keyof typeof errors) =>
    submitted && errors[key] ? (
      <p id={`${uid}-${key}-error`} className="text-sm text-destructive" role="alert">
        {errors[key]}
      </p>
    ) : null;
  const described = (key: keyof typeof errors) => (submitted && errors[key] ? `${uid}-${key}-error` : undefined);

  const numberField = (key: "baselineValue" | "currentValue" | "targetValue", label: string, errKey: "baseline" | "current" | "target") => (
    <div className="space-y-2">
      <Label htmlFor={`${uid}-${key}`}>{label}</Label>
      <Input
        id={`${uid}-${key}`}
        inputMode="decimal"
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
        placeholder="Not recorded"
        aria-invalid={Boolean(submitted && errors[errKey])}
        aria-describedby={described(errKey)}
      />
      {err(errKey)}
    </div>
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <DialogHeader>
        <DialogTitle>{outcome ? "Update outcome" : "Track an outcome"}</DialogTitle>
        <DialogDescription>
          {outcome
            ? outcome.recommendation.title
            : "Choose a recommendation and the metric that shows whether it worked. Progress is measured from baseline toward target."}
        </DialogDescription>
      </DialogHeader>

      {!outcome && (
        <div className="space-y-2">
          <Label htmlFor={`${uid}-rec`}>Recommendation</Label>
          {options.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading recommendations…</p>
          ) : options.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Couldn&apos;t load recommendations.{" "}
              <button type="button" className="underline" onClick={() => void options.refetch()}>
                Try again
              </button>
            </p>
          ) : (options.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Every recommendation in this project is already tracked, or there are none yet.</p>
          ) : (
            <Select value={form.recommendationId} onValueChange={(v) => set("recommendationId", v)}>
              <SelectTrigger id={`${uid}-rec`} aria-invalid={Boolean(submitted && errors.recommendation)} aria-describedby={described("recommendation")}>
                <SelectValue placeholder="Choose a recommendation" />
              </SelectTrigger>
              <SelectContent>
                {(options.data ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.title} ({r.status.toLowerCase()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {err("recommendation")}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${uid}-status`}>Status</Label>
          <Select value={form.status} onValueChange={(v) => set("status", v as OutcomeStatus)}>
            <SelectTrigger id={`${uid}-status`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTCOME_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{OUTCOME_STATUS_OPTIONS.find((o) => o.value === form.status)?.description}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${uid}-metric`}>Metric</Label>
          <Input
            id={`${uid}-metric`}
            value={form.metricName}
            onChange={(e) => set("metricName", e.target.value)}
            placeholder="e.g. Weekly active exporters"
            maxLength={150}
            aria-invalid={Boolean(submitted && errors.metricName)}
            aria-describedby={described("metricName")}
          />
          {err("metricName")}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {numberField("baselineValue", "Baseline", "baseline")}
        {numberField("currentValue", "Current", "current")}
        {numberField("targetValue", "Target", "target")}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${uid}-notes`}>Notes</Label>
        <Textarea
          id={`${uid}-notes`}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="How was it measured? Anything that affected the result?"
          aria-invalid={Boolean(submitted && errors.notes)}
          aria-describedby={described("notes")}
        />
        {err("notes")}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || (!outcome && (options.data ?? []).length === 0)}>
          {pending ? "Saving…" : outcome ? "Save" : "Start tracking"}
        </Button>
      </DialogFooter>
    </form>
  );
}
