"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useJobRun } from "@/components/ui/use-job-run";
import { trpc } from "@/lib/trpc";

const MAX_CSV_BYTES = 1024 * 1024;
type Source = "CSV" | "LINEAR" | "JIRA" | "NOTION" | "PRODUCTBOARD";

const SOURCES: Array<{ value: Source; label: string }> = [
  { value: "CSV", label: "CSV file" },
  { value: "LINEAR", label: "Linear" },
  { value: "JIRA", label: "Jira" },
  { value: "NOTION", label: "Notion" },
  { value: "PRODUCTBOARD", label: "Productboard" },
];
const SOURCE_NAME: Record<Source, string> = { CSV: "CSV", LINEAR: "Linear", JIRA: "Jira", NOTION: "Notion", PRODUCTBOARD: "Productboard" };

interface ImportResult {
  roadmapId: string;
  created: number;
  updated: number;
  skippedCount: number;
  truncated: boolean;
}

/** The result stored in a finished ROADMAP_IMPORT job's output. */
function readResult(output: unknown): ImportResult | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Partial<ImportResult>;
  if (typeof o.roadmapId !== "string" || typeof o.created !== "number" || typeof o.updated !== "number") return null;
  return { roadmapId: o.roadmapId, created: o.created, updated: o.updated, skippedCount: o.skippedCount ?? 0, truncated: Boolean(o.truncated) };
}

interface ImportDialogProps {
  projectId: string;
  /** Currently selected roadmap (offered as the import target). */
  roadmap: { id: string; name: string } | null;
  onImported: (roadmapId: string) => void;
}

export function ImportDialog({ projectId, roadmap, onImported }: ImportDialogProps) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("CSV");
  const [target, setTarget] = useState<"existing" | "new">(roadmap ? "existing" : "new");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [teamId, setTeamId] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [databaseId, setDatabaseId] = useState("");
  const [reading, setReading] = useState(false);
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const [jobSource, setJobSource] = useState<Source>("LINEAR");
  const [jobError, setJobError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(roadmap ? "existing" : "new");
    setFile(null);
    setFileError(null);
    if (!jobRunId) setJobError(null);
  }, [open, roadmap, jobRunId]);

  const finish = async (res: ImportResult) => {
    await Promise.all([utils.roadmap.list.invalidate({ projectId }), utils.roadmap.get.invalidate({ projectId, roadmapId: res.roadmapId })]);
    const parts = [`${res.created} added`, `${res.updated} updated`];
    if (res.skippedCount > 0) parts.push(`${res.skippedCount} skipped`);
    toast.success(`Import complete: ${parts.join(", ")}${res.truncated ? " (import limit reached)" : ""}`);
    onImported(res.roadmapId);
    setOpen(false);
  };

  // Integration imports run in the background; this keeps polling even if the dialog is closed.
  const job = useJobRun(jobRunId, {
    onReady: (output) => {
      setJobRunId(null);
      const res = readResult(output);
      if (res) void finish(res);
    },
    onFailed: (message) => {
      setJobRunId(null);
      setJobError(message);
      toast.error(`${SOURCE_NAME[jobSource]} import failed: ${message}`);
    },
  });

  const mutation = trpc.roadmap.import.useMutation({
    onSuccess: async (res, vars) => {
      if (res.mode === "done") {
        await finish(res);
        return;
      }
      setJobError(null);
      setJobSource(vars.source);
      setJobRunId(res.jobRunId);
      if (res.alreadyRunning) toast.info(`An import from ${SOURCE_NAME[vars.source]} is already running`);
    },
  });
  const submitting = mutation.isPending || reading;
  const pending = submitting || job.isRunning;

  const onFile = (f: File | null) => {
    setFileError(null);
    if (f && f.size > MAX_CSV_BYTES) {
      setFile(null);
      setFileError("The file is larger than 1 MB. Split it into smaller files.");
      return;
    }
    if (f && !/\.csv$/i.test(f.name)) {
      setFile(null);
      setFileError("Choose a .csv file.");
      return;
    }
    setFile(f);
  };

  const common = () => ({
    projectId,
    ...(target === "existing" && roadmap ? { roadmapId: roadmap.id } : {}),
    ...(target === "new" && name.trim() ? { name: name.trim() } : {}),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    switch (source) {
      case "CSV": {
        if (!file) {
          setFileError("Choose a CSV file to import.");
          return;
        }
        setReading(true);
        try {
          const csv = await file.text();
          mutation.mutate({ ...common(), source: "CSV", csv, filename: file.name.slice(0, 200) });
        } catch {
          setFileError("The file could not be read.");
        } finally {
          setReading(false);
        }
        return;
      }
      case "LINEAR":
        mutation.mutate({ ...common(), source: "LINEAR", ...(teamId.trim() ? { teamId: teamId.trim() } : {}) });
        return;
      case "JIRA":
        mutation.mutate({ ...common(), source: "JIRA", projectKey: projectKey.trim() });
        return;
      case "NOTION":
        mutation.mutate({ ...common(), source: "NOTION", databaseId: databaseId.trim() });
        return;
      case "PRODUCTBOARD":
        mutation.mutate({ ...common(), source: "PRODUCTBOARD" });
        return;
    }
  };

  const canSubmit =
    !pending &&
    (source === "CSV" ? Boolean(file) : source === "JIRA" ? projectKey.trim().length > 0 : source === "NOTION" ? databaseId.trim().length > 0 : true);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload className="mr-2 h-4 w-4" aria-hidden />
        Import
      </Button>
      <Dialog open={open} onOpenChange={(o) => !submitting && setOpen(o)}>
        <DialogContent className="max-w-lg">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Import roadmap items</DialogTitle>
              <DialogDescription>
                Items are matched on their external ID, so importing the same source again updates items instead of duplicating them.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="roadmap-import-source">Source</Label>
              <Select value={source} onValueChange={(v) => setSource(v as Source)}>
                <SelectTrigger id="roadmap-import-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="roadmap-import-target">Import into</Label>
              <Select value={target} onValueChange={(v) => setTarget(v as "existing" | "new")}>
                <SelectTrigger id="roadmap-import-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roadmap && <SelectItem value="existing">{`Selected roadmap: ${roadmap.name}`}</SelectItem>}
                  <SelectItem value="new">A new roadmap</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {target === "new" && (
              <div className="space-y-2">
                <Label htmlFor="roadmap-import-name">New roadmap name (optional)</Label>
                <Input id="roadmap-import-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
              </div>
            )}

            {source === "CSV" && (
              <div className="space-y-2">
                <Label htmlFor="roadmap-import-file">CSV file (max 1 MB)</Label>
                <Input
                  id="roadmap-import-file"
                  type="file"
                  accept=".csv,text/csv"
                  aria-describedby="roadmap-import-file-help"
                  aria-invalid={fileError ? true : undefined}
                  onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                />
                <p id="roadmap-import-file-help" className="text-xs text-muted-foreground">
                  Required column: <code>title</code>. Optional: <code>description</code>, <code>status</code> (planned, in progress,
                  completed, cancelled), <code>priority</code> (P0–P3), <code>quarter</code>, <code>externalId</code>. Up to 2,000 rows.
                </p>
                {fileError && (
                  <p role="alert" className="text-sm text-destructive">
                    {fileError}
                  </p>
                )}
              </div>
            )}
            {source === "LINEAR" && (
              <div className="space-y-2">
                <Label htmlFor="roadmap-import-team">Linear team ID (optional)</Label>
                <Input id="roadmap-import-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} maxLength={64} aria-describedby="roadmap-import-team-help" />
                <p id="roadmap-import-team-help" className="text-xs text-muted-foreground">
                  Uses your workspace&apos;s connected Linear integration. Leave empty to use the team configured on the integration.
                </p>
              </div>
            )}
            {source === "JIRA" && (
              <div className="space-y-2">
                <Label htmlFor="roadmap-import-key">Jira project key</Label>
                <Input
                  id="roadmap-import-key"
                  value={projectKey}
                  onChange={(e) => setProjectKey(e.target.value.toUpperCase())}
                  maxLength={10}
                  placeholder="PROD"
                  required
                  aria-describedby="roadmap-import-key-help"
                />
                <p id="roadmap-import-key-help" className="text-xs text-muted-foreground">
                  Imports up to 500 issues from the project using your workspace&apos;s connected Jira integration.
                </p>
              </div>
            )}
            {source === "NOTION" && (
              <div className="space-y-2">
                <Label htmlFor="roadmap-import-db">Notion database ID</Label>
                <Input
                  id="roadmap-import-db"
                  value={databaseId}
                  onChange={(e) => setDatabaseId(e.target.value)}
                  maxLength={36}
                  required
                  aria-describedby="roadmap-import-db-help"
                />
                <p id="roadmap-import-db-help" className="text-xs text-muted-foreground">
                  The 32-character ID from the database URL. The database must be shared with Beacon&apos;s Notion integration.
                </p>
              </div>
            )}

            {source === "PRODUCTBOARD" && (
              <p className="text-xs text-muted-foreground">
                Imports up to 500 features (name, description, status and timeframe) using your workspace&apos;s connected Productboard
                integration. Archived features are skipped.
              </p>
            )}

            <div aria-live="polite">
              {job.isRunning && (
                <p className="flex items-start gap-2 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900" role="status">
                  <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin" aria-hidden />
                  <span>
                    Importing from {SOURCE_NAME[jobSource]} in the background. You can close this dialog; you&apos;ll be notified when it
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
