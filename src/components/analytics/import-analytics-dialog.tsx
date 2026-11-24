"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useJobRun } from "@/components/ui/use-job-run";
import { trpc } from "@/lib/trpc";

const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_RANGE_DAYS = 90;
type Source = "CSV" | "AMPLITUDE" | "MIXPANEL";
const PROVIDER_LABEL: Record<Source, string> = { CSV: "CSV file", AMPLITUDE: "Amplitude", MIXPANEL: "Mixpanel" };

/** UTC calendar date (the server validates ranges in UTC). */
function utcDate(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

interface ImportSummary {
  points: number;
  series: number;
  skipped: number;
  truncated: boolean;
}

/** The summary stored in a finished ANALYTICS_IMPORT job's output. */
function readSummary(output: unknown): ImportSummary | null {
  const s = (output as { summary?: Partial<ImportSummary> } | null)?.summary;
  if (!s || typeof s.points !== "number" || typeof s.series !== "number") return null;
  return { points: s.points, series: s.series, skipped: s.skipped ?? 0, truncated: Boolean(s.truncated) };
}

function rangeError(start: string, end: string): string | null {
  if (!start || !end) return "Choose a start and end date.";
  const s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e)) return "Enter valid dates.";
  if (s > e) return "The start date must be on or before the end date.";
  if (end > utcDate()) return "The end date cannot be in the future.";
  if (Math.round((e - s) / 86_400_000) + 1 > MAX_RANGE_DAYS) return `The range can be at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

export function ImportAnalyticsDialog({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("CSV");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [start, setStart] = useState(utcDate(-29));
  const [end, setEnd] = useState(utcDate());
  const [reading, setReading] = useState(false);
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const [jobSource, setJobSource] = useState<Source>("AMPLITUDE");
  const [jobError, setJobError] = useState<string | null>(null);

  const sources = trpc.analytics.listSources.useQuery({ projectId }, { enabled: open });
  const connected = useMemo(
    () => (sources.data ?? []).filter((s) => s.connected && s.provider === source),
    [sources.data, source]
  );

  useEffect(() => {
    if (open) {
      setFile(null);
      setFileError(null);
      if (!jobRunId) setJobError(null);
    }
  }, [open, jobRunId]);

  const finish = async (s: ImportSummary) => {
    await Promise.all([
      utils.analytics.getImports.invalidate({ projectId }),
      utils.analytics.listSeries.invalidate({ projectId }),
      utils.analytics.getSeries.invalidate({ projectId }),
    ]);
    toast.success(
      `Imported ${s.points.toLocaleString()} data points across ${s.series} series${s.skipped ? ` (${s.skipped} rows skipped)` : ""}${s.truncated ? "; the import limit was reached" : ""}`
    );
    setOpen(false);
  };

  // Integration imports run in the background; this keeps polling even if the dialog is closed.
  const job = useJobRun(jobRunId, {
    onReady: (output) => {
      setJobRunId(null);
      const s = readSummary(output);
      if (s) void finish(s);
    },
    onFailed: (message) => {
      setJobRunId(null);
      setJobError(message);
      toast.error(`${PROVIDER_LABEL[jobSource]} import failed: ${message}`);
    },
  });

  const mutation = trpc.analytics.importData.useMutation({
    onSuccess: async (res, vars) => {
      if (res.mode === "done") {
        await finish(res.summary);
        return;
      }
      setJobError(null);
      setJobSource(vars.source);
      setJobRunId(res.jobRunId);
      if (res.alreadyRunning) toast.info(`An import from ${PROVIDER_LABEL[vars.source]} is already running`);
    },
  });
  const submitting = mutation.isPending || reading;
  const pending = submitting || job.isRunning;
  const dateError = source === "CSV" ? null : rangeError(start, end);

  const onFile = (f: File | null) => {
    setFileError(null);
    if (f && f.size > MAX_CSV_BYTES) {
      setFile(null);
      setFileError("The file is larger than 2 MB. Split it into smaller files.");
      return;
    }
    if (f && !/\.csv$/i.test(f.name)) {
      setFile(null);
      setFileError("Choose a .csv file.");
      return;
    }
    setFile(f);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (source === "CSV") {
      if (!file) {
        setFileError("Choose a CSV file to import.");
        return;
      }
      setReading(true);
      try {
        const csv = await file.text();
        mutation.mutate({ projectId, source: "CSV", csv, filename: file.name.slice(0, 200) });
      } catch {
        setFileError("The file could not be read.");
      } finally {
        setReading(false);
      }
      return;
    }
    if (dateError || connected.length === 0) return;
    mutation.mutate({ projectId, source, integrationId: connected[0].id, startDate: start, endDate: end });
  };

  const canSubmit = !pending && (source === "CSV" ? Boolean(file) : connected.length > 0 && !dateError);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Upload className="mr-2 h-4 w-4" aria-hidden />
        Import usage data
      </Button>
      <Dialog open={open} onOpenChange={(o) => !submitting && setOpen(o)}>
        <DialogContent className="max-w-lg">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Import usage data</DialogTitle>
              <DialogDescription>Daily product metrics are correlated with how often customers raise each theme.</DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="analytics-import-source">Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v as Source)}>
                <SelectTrigger id="analytics-import-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROVIDER_LABEL) as Source[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {PROVIDER_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {source === "CSV" ? (
              <div className="space-y-2">
                <Label htmlFor="analytics-import-file">CSV file (max 2 MB)</Label>
                <Input
                  id="analytics-import-file"
                  type="file"
                  accept=".csv,text/csv"
                  aria-describedby="analytics-import-file-help"
                  aria-invalid={fileError ? true : undefined}
                  onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                />
                <p id="analytics-import-file-help" className="text-xs text-muted-foreground">
                  Columns: <code>feature</code>, <code>metric</code>, <code>value</code>, <code>date</code> (YYYY-MM-DD) and optionally{" "}
                  <code>segment</code>. One row per feature, metric and day; up to 10,000 rows.
                </p>
                {fileError && (
                  <p role="alert" className="text-sm text-destructive">
                    {fileError}
                  </p>
                )}
              </div>
            ) : (
              <>
                {sources.isLoading ? (
                  <p className="text-sm text-muted-foreground">Checking connected integrations…</p>
                ) : sources.isError ? (
                  <p role="alert" className="text-sm text-destructive">
                    Couldn&apos;t check integrations: {sources.error.message}
                  </p>
                ) : connected.length === 0 ? (
                  <p className="rounded-lg bg-gray-50 p-3 text-sm text-muted-foreground dark:bg-gray-900">
                    {PROVIDER_LABEL[source]} isn&apos;t connected for this workspace.{" "}
                    <Link href="/integrations" className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400">
                      Connect it on the Integrations page
                    </Link>{" "}
                    and try again.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Imports daily unique users for the top events from your connected {PROVIDER_LABEL[source]} project.
                  </p>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="analytics-import-start">Start date</Label>
                    <Input id="analytics-import-start" type="date" value={start} max={end || utcDate()} onChange={(e) => setStart(e.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="analytics-import-end">End date</Label>
                    <Input id="analytics-import-end" type="date" value={end} min={start} max={utcDate()} onChange={(e) => setEnd(e.target.value)} required />
                  </div>
                </div>
                {dateError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {dateError}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Up to {MAX_RANGE_DAYS} days per import.</p>
                )}
              </>
            )}

            <div aria-live="polite">
              {job.isRunning && (
                <p className="flex items-start gap-2 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900" role="status">
                  <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" aria-hidden />
                  <span>
                    Importing from {PROVIDER_LABEL[jobSource]} in the background. You can close this dialog; you&apos;ll be notified when it
                    finishes.
                  </span>
                </p>
              )}
              {jobError && !job.isRunning && (
                <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
                  {jobError}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                {job.isRunning ? "Close" : "Cancel"}
              </Button>
              <Button type="submit" disabled={!canSubmit}>
                {pending ? "Importing…" : "Import"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
