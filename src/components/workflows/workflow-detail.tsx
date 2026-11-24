"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Loader2, Play, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { RunHistory } from "./run-history";
import { WorkflowBuilder } from "./workflow-builder";

const TERMINAL = new Set(["READY", "FAILED"]);

export function WorkflowDetail({ id }: { id: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState("runs");

  const workflow = trpc.workflow.get.useQuery({ id });
  const job = trpc.job.get.useQuery(
    { id: jobId ?? "" },
    {
      enabled: !!jobId,
      refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : 1500),
    }
  );

  const toggle = trpc.workflow.toggle.useMutation({
    onSuccess: async (res) => {
      toast.success(res.enabled ? "Workflow enabled" : "Workflow disabled");
      await Promise.all([utils.workflow.get.invalidate({ id }), utils.workflow.list.invalidate()]);
    },
  });
  const run = trpc.workflow.runManually.useMutation({
    onSuccess: (res) => {
      setJobId(res.jobRunId);
      toast.info("Run queued");
    },
  });
  const remove = trpc.workflow.delete.useMutation({
    onSuccess: async () => {
      toast.success("Workflow deleted");
      await utils.workflow.list.invalidate();
      router.push("/workflows");
    },
  });

  const jobStatus = job.data?.status;
  const running = !!jobId && (!jobStatus || !TERMINAL.has(jobStatus));
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!jobId || !jobStatus || !TERMINAL.has(jobStatus) || announced.current === jobId) return;
    announced.current = jobId;
    const output = (job.data?.output ?? {}) as { status?: string };
    if (jobStatus === "READY") toast.success(output.status === "PARTIAL_FAILURE" ? "Run finished with some failed actions" : "Run finished");
    else toast.error(job.data?.errorMessage ?? "The run failed");
    void utils.workflow.runs.invalidate({ workflowId: id });
    void utils.workflow.get.invalidate({ id });
  }, [jobId, jobStatus, job.data, utils, id]);

  if (workflow.isLoading) return <LoadingState rows={4} label="Loading workflow" />;
  if (workflow.isError) return <ErrorState message={workflow.error.message} onRetry={() => void workflow.refetch()} />;
  const wf = workflow.data!;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/workflows" className="inline-flex items-center gap-1 text-sm text-gray-600 hover:underline dark:text-gray-400">
          <ArrowLeft className="h-4 w-4" aria-hidden /> All workflows
        </Link>
      </div>
      <div className="flex flex-col gap-4 border-b pb-6 md:flex-row md:items-start md:justify-between dark:border-gray-800">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">{wf.name}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {wf.project.name} · {wf.triggerLabel} · {wf.runCount} run{wf.runCount === 1 ? "" : "s"}
            {wf.lastRunAt && <> · last {formatDistanceToNow(new Date(wf.lastRunAt), { addSuffix: true })}</>}
          </p>
          {wf.description && <p className="max-w-2xl text-sm">{wf.description}</p>}
          {!wf.trigger.event && <Badge variant="destructive">This workflow uses an unsupported trigger. Edit it to choose a new one.</Badge>}
        </div>
        {wf.canManage && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch id="wf-enabled" checked={wf.enabled} disabled={toggle.isPending} onCheckedChange={(enabled) => toggle.mutate({ id, enabled })} />
              <Label htmlFor="wf-enabled">{wf.enabled ? "Enabled" : "Disabled"}</Label>
            </div>
            <Button onClick={() => run.mutate({ id })} disabled={run.isPending || running}>
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Play className="mr-2 h-4 w-4" aria-hidden />}
              {running ? "Running…" : "Run now"}
            </Button>
            <Button variant="outline" onClick={() => setConfirmDelete(true)} aria-label="Delete workflow">
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {running ? "Workflow run in progress" : jobStatus ? `Workflow run ${jobStatus === "READY" ? "finished" : "failed"}` : ""}
      </p>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="runs">Run history</TabsTrigger>
          <TabsTrigger value="definition">{wf.canManage ? "Edit" : "Definition"}</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="mt-4">
          <RunHistory workflowId={id} polling={running} />
        </TabsContent>
        <TabsContent value="definition" className="mt-4">
          {!wf.canManage && <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">You can view this workflow. Members and admins can edit it.</p>}
          <WorkflowBuilder
            key={wf.updatedAt.toString()}
            mode="edit"
            workflowId={wf.id}
            projectId={wf.project.id}
            readOnly={!wf.canManage}
            initial={{
              name: wf.name,
              description: wf.description ?? "",
              trigger: { event: wf.trigger.event, conditions: wf.trigger.conditions },
              actions: wf.actions,
              enabled: wf.enabled,
            }}
            onSaved={() => setTab("runs")}
          />
        </TabsContent>
      </Tabs>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this workflow?</DialogTitle>
            <DialogDescription>Its run history is deleted too. This can&apos;t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => remove.mutate({ id })} disabled={remove.isPending}>
              {remove.isPending ? "Deleting…" : "Delete workflow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
