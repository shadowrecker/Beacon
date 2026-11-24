"use client";

/**
 * Engineering handoff export for one recommendation.
 *
 * - Markdown: generated on request (reusing the stored feature brief) and shown
 *   as plain text with copy and download.
 * - Jira / Linear: creates an issue through the workspace's own integration via
 *   a background job; the dialog polls job.get until it finishes and links to
 *   the created issue.
 *
 * Usage: <ExportDialog projectId={...} recommendationId={...} />
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, Download, FileText, Loader2, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ExternalLink, safeHref } from "@/components/ui/external-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type Target = "MARKDOWN" | "JIRA" | "LINEAR";
type MarkdownResult = Extract<RouterOutputs["handoff"]["export"], { target: "MARKDOWN" }>;

const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const LINEAR_TEAM = /^[a-zA-Z0-9-]{1,64}$/;
const POLL_MS = 2_000;

function readIssue(output: unknown): { issueKey: string; url: string | null } | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { issueKey?: unknown; url?: unknown };
  if (typeof o.issueKey !== "string") return null;
  return { issueKey: o.issueKey, url: typeof o.url === "string" ? safeHref(o.url) : null };
}

export function ExportDialog({
  projectId,
  recommendationId,
  recommendationTitle,
  trigger,
}: {
  projectId: string;
  recommendationId: string;
  recommendationTitle?: string;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Target>("MARKDOWN");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-2">
            <Share2 className="h-4 w-4" aria-hidden />
            Export
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Engineering handoff</DialogTitle>
          <DialogDescription>
            {recommendationTitle ? <>Export &ldquo;{recommendationTitle}&rdquo; </> : "Export this recommendation "}
            as a specification. Customer quotes are kept in a separate, clearly labelled section and are never presented as instructions.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as Target)}>
            <TabsList aria-label="Export target">
              <TabsTrigger value="MARKDOWN">Markdown</TabsTrigger>
              <TabsTrigger value="JIRA">Jira</TabsTrigger>
              <TabsTrigger value="LINEAR">Linear</TabsTrigger>
            </TabsList>
            <TabsContent value="MARKDOWN" className="pt-4">
              <MarkdownExport projectId={projectId} recommendationId={recommendationId} />
            </TabsContent>
            <TabsContent value="JIRA" className="pt-4">
              <IssueExport projectId={projectId} recommendationId={recommendationId} target="JIRA" />
            </TabsContent>
            <TabsContent value="LINEAR" className="pt-4">
              <IssueExport projectId={projectId} recommendationId={recommendationId} target="LINEAR" />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MarkdownExport({ projectId, recommendationId }: { projectId: string; recommendationId: string }) {
  const [doc, setDoc] = useState<MarkdownResult | null>(null);
  const previewId = useId();
  const exportDoc = trpc.handoff.export.useMutation({
    onSuccess: (res) => {
      if (res.target === "MARKDOWN") setDoc(res);
    },
  });

  const copy = async () => {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(doc.content);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it manually.");
    }
  };
  const download = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([doc.content], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (!doc) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Builds a Markdown spec (problem, user stories, requirements, success metrics, implementation notes and customer evidence). A feature brief is generated first if this recommendation doesn&apos;t have one yet.
        </p>
        <Button onClick={() => exportDoc.mutate({ projectId, recommendationId, target: "MARKDOWN" })} disabled={exportDoc.isPending} className="gap-2">
          {exportDoc.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileText className="h-4 w-4" aria-hidden />}
          {exportDoc.isPending ? "Preparing…" : "Generate Markdown"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {doc.filename} · {doc.quoteCount} customer quote{doc.quoteCount === 1 ? "" : "s"} (in the untrusted evidence section)
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="gap-2" onClick={() => void copy()}>
            <Copy className="h-4 w-4" aria-hidden />
            Copy
          </Button>
          <Button variant="outline" size="sm" className="gap-2" onClick={download}>
            <Download className="h-4 w-4" aria-hidden />
            Download .md
          </Button>
        </div>
      </div>
      <Label htmlFor={previewId} className="sr-only">
        Markdown preview
      </Label>
      <textarea
        id={previewId}
        readOnly
        value={doc.content}
        className="h-96 w-full resize-y rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
      />
    </div>
  );
}

function IssueExport({ projectId, recommendationId, target }: { projectId: string; recommendationId: string; target: "JIRA" | "LINEAR" }) {
  const label = target === "JIRA" ? "Jira" : "Linear";
  const fieldId = useId();
  const utils = trpc.useUtils();
  const [override, setOverride] = useState("");
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const announced = useRef<string | null>(null);

  const targets = trpc.handoff.targets.useQuery({ projectId });
  const history = trpc.handoff.history.useQuery({ projectId, recommendationId, limit: 5 });
  const connected = target === "JIRA" ? targets.data?.jira : targets.data?.linear;

  const job = trpc.job.get.useQuery(
    { id: jobRunId ?? "" },
    {
      enabled: Boolean(jobRunId),
      refetchInterval: (q) => {
        const s = q.state.data?.status;
        return s === "PENDING" || s === "PROCESSING" ? POLL_MS : false;
      },
    }
  );
  const status = job.data?.status;
  const issue = readIssue(job.data?.output);

  useEffect(() => {
    if (!jobRunId || announced.current === jobRunId) return;
    if (status === "READY") {
      announced.current = jobRunId;
      toast.success(`${label} issue created`);
      void utils.handoff.history.invalidate({ projectId, recommendationId });
    } else if (status === "FAILED") {
      announced.current = jobRunId;
      void utils.handoff.history.invalidate({ projectId, recommendationId });
    }
  }, [status, jobRunId, label, utils, projectId, recommendationId]);

  const exportIssue = trpc.handoff.export.useMutation({
    onSuccess: (res) => {
      if (res.target !== "MARKDOWN" && res.jobRunId) {
        setJobRunId(res.jobRunId);
        if (res.alreadyRunning) toast.info(`An export to ${label} is already in progress`);
      }
    },
  });

  const trimmed = override.trim();
  const overrideValid = !trimmed || (target === "JIRA" ? JIRA_KEY.test(trimmed.toUpperCase()) : LINEAR_TEAM.test(trimmed));
  const running = exportIssue.isPending || status === "PENDING" || status === "PROCESSING";

  const start = () => {
    if (!overrideValid) return;
    exportIssue.mutate({
      projectId,
      recommendationId,
      target,
      ...(trimmed && target === "JIRA" ? { jiraProjectKey: trimmed.toUpperCase() } : {}),
      ...(trimmed && target === "LINEAR" ? { linearTeamId: trimmed } : {}),
    });
  };

  if (targets.isLoading) return <p className="text-sm text-muted-foreground">Checking connected integrations…</p>;
  if (targets.isError) {
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>Couldn&apos;t check which integrations are connected.</p>
        <Button variant="outline" size="sm" onClick={() => void targets.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{label} isn&apos;t connected for this workspace. An admin can connect it from Integrations.</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/integrations">Open integrations</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Creates a {label} issue with the specification using your workspace&apos;s {label} connection.
      </p>
      <div className="max-w-xs space-y-2">
        <Label htmlFor={fieldId}>{target === "JIRA" ? "Jira project key (optional)" : "Linear team ID (optional)"}</Label>
        <Input
          id={fieldId}
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          placeholder={target === "JIRA" ? "Uses the integration default, e.g. PROD" : "Uses the integration default"}
          aria-invalid={!overrideValid}
          aria-describedby={!overrideValid ? `${fieldId}-error` : undefined}
          maxLength={64}
        />
        {!overrideValid && (
          <p id={`${fieldId}-error`} className="text-sm text-destructive" role="alert">
            {target === "JIRA" ? "Use a project key like PROD (letters, digits, underscore)" : "Use letters, digits and dashes only"}
          </p>
        )}
      </div>
      <Button onClick={start} disabled={running || !overrideValid} className="gap-2">
        {running && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        {running ? `Creating ${label} issue…` : `Create ${label} issue`}
      </Button>

      <div aria-live="polite">
        {status === "READY" && issue && (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
            Created <ExternalLink href={issue.url}>{issue.issueKey}</ExternalLink>
          </p>
        )}
        {status === "FAILED" && (
          <p role="alert" className="text-sm text-destructive">
            {job.data?.errorMessage ?? `The ${label} export failed.`}
          </p>
        )}
      </div>

      {history.data && history.data.some((h) => h.target === target) && (
        <section aria-label={`Previous ${label} exports`} className="space-y-2 border-t pt-3">
          <h4 className="text-sm font-medium">Previous exports</h4>
          <ul className="space-y-1 text-sm">
            {history.data
              .filter((h) => h.target === target)
              .map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">{new Date(h.createdAt).toLocaleString()}</span>
                  {h.status === "READY" && h.issueKey ? (
                    <ExternalLink href={h.url}>{h.issueKey}</ExternalLink>
                  ) : h.status === "FAILED" ? (
                    <span className="text-destructive">Failed{h.errorMessage ? `: ${h.errorMessage}` : ""}</span>
                  ) : (
                    <span>In progress</span>
                  )}
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}
