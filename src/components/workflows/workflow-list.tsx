"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Workflow as WorkflowIcon } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ACTION_META } from "@/server/workflows/definitions";
import { RunStatusBadge } from "./run-status-badge";

function actionLabel(type: string): string {
  return type in ACTION_META ? ACTION_META[type as keyof typeof ACTION_META].label : type;
}

export function WorkflowList() {
  const utils = trpc.useUtils();
  const list = trpc.workflow.list.useInfiniteQuery({ limit: 25 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const toggle = trpc.workflow.toggle.useMutation({
    onSuccess: async (res) => {
      toast.success(res.enabled ? "Workflow enabled" : "Workflow disabled");
      await utils.workflow.list.invalidate();
    },
  });

  if (list.isLoading) return <LoadingState rows={4} label="Loading workflows" />;
  if (list.isError) return <ErrorState message={list.error.message} onRetry={() => void list.refetch()} />;
  const pages = list.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const canManage = pages[0]?.canManage ?? false;

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<WorkflowIcon className="h-8 w-8" />}
        title="No workflows yet"
        description="Workflows react to events in your projects: post to Slack, open Jira issues, generate briefs and more."
        action={
          canManage ? (
            <Button asChild>
              <Link href="/workflows/new">Create a workflow</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border dark:divide-gray-800 dark:border-gray-800">
        {items.map((wf) => (
          <li key={wf.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/workflows/${wf.id}`} className="font-semibold hover:underline">
                  {wf.name}
                </Link>
                {!wf.enabled && <Badge variant="secondary">Disabled</Badge>}
                {wf.lastRunStatus && <RunStatusBadge status={wf.lastRunStatus} />}
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {wf.project.name} · When <span className="font-medium">{wf.trigger.label.toLowerCase()}</span>
                {wf.trigger.conditionCount > 0 && ` (${wf.trigger.conditionCount} condition${wf.trigger.conditionCount === 1 ? "" : "s"})`} →{" "}
                {wf.actionTypes.map(actionLabel).join(", ")}
              </p>
              <p className="text-xs text-gray-500">
                {wf.runCount} run{wf.runCount === 1 ? "" : "s"}
                {wf.lastRunAt && ` · last ${formatDistanceToNow(new Date(wf.lastRunAt), { addSuffix: true })}`}
              </p>
            </div>
            {canManage && (
              <div className="flex items-center gap-2">
                <Switch
                  checked={wf.enabled}
                  disabled={toggle.isPending}
                  onCheckedChange={(enabled) => toggle.mutate({ id: wf.id, enabled })}
                  aria-label={`${wf.enabled ? "Disable" : "Enable"} ${wf.name}`}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
