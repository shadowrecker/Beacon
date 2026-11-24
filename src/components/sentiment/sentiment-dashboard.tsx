"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useJobRun } from "@/components/ui/use-job-run";
import { AlertFeed } from "./alert-feed";
import { ChurnTable } from "./churn-table";
import { CurrentSentiment } from "./current-sentiment";
import { SegmentBreakdown } from "./segment-breakdown";
import { TrendChart } from "./trend-chart";
import { PERIOD_LABELS, type Period } from "./format";

interface RunOutput {
  status?: string;
  volume?: number;
  totalChunks?: number;
  sampledChunks?: number;
  alertsCreated?: number;
}

/** Sentiment, alerts and churn-risk view for one project, with on-demand analysis. */
export function SentimentDashboard({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const [period, setPeriod] = useState<Period>("WEEKLY");
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const current = trpc.sentiment.getCurrentSentiment.useQuery({ projectId, period });
  const perms = current.data?.permissions;

  const run = trpc.sentiment.runAnalysis.useMutation({
    onSuccess: (res) => {
      setJobRunId(res.jobRunId);
      toast.info(res.deduplicated ? "An analysis for this period is already running" : "Analysis started");
    },
  });
  const job = useJobRun(jobRunId, {
    onReady: async (output) => {
      const o = (output ?? {}) as RunOutput;
      if (o.status === "empty") toast.info("No new feedback in this period to analyze");
      else {
        const sampled = o.sampledChunks !== undefined && o.totalChunks !== undefined && o.sampledChunks < o.totalChunks ? ` (sampled ${o.sampledChunks} of ${o.totalChunks})` : "";
        toast.success(`Analyzed ${o.volume ?? 0} feedback items${sampled}${o.alertsCreated ? `, ${o.alertsCreated} new alert(s)` : ""}`);
      }
      setJobRunId(null);
      await utils.sentiment.invalidate();
    },
    onFailed: (message) => {
      toast.error(`Analysis failed: ${message}`);
      setJobRunId(null);
    },
  });
  const running = run.isPending || job.isRunning;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="w-44 space-y-1.5">
          <Label htmlFor="sentiment-period">Period</Label>
          <Select value={period} onValueChange={(v) => setPeriod(v as Period)}>
            <SelectTrigger id="sentiment-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {perms?.canRun && (
          <Button variant="outline" disabled={running} onClick={() => run.mutate({ projectId, period })}>
            <RefreshCw className={`mr-2 h-4 w-4 ${running ? "animate-spin" : ""}`} aria-hidden />
            {running ? "Analyzing…" : `Analyze current ${PERIOD_LABELS[period].toLowerCase()} period`}
          </Button>
        )}
      </div>
      {running && (
        <p role="status" className="text-sm text-muted-foreground">
          Classifying this period&apos;s feedback. This can take a few minutes for large periods.
        </p>
      )}

      <CurrentSentiment projectId={projectId} period={period} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TrendChart projectId={projectId} period={period} />
        </div>
        <SegmentBreakdown projectId={projectId} period={period} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <AlertFeed projectId={projectId} canWrite={perms?.canWrite ?? false} />
        <ChurnTable projectId={projectId} />
      </div>
    </div>
  );
}
