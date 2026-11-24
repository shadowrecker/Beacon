"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Radar } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";

interface ScanOutput {
  pagesFetched?: number;
  updatesCreated?: number;
  alertsCreated?: number;
  deferred?: number;
  baseline?: boolean;
}

function summary(output: unknown): string {
  const o = (output && typeof output === "object" ? output : {}) as ScanOutput;
  const updates = o.updatesCreated ?? 0;
  const parts = [`${updates} new update${updates === 1 ? "" : "s"} from ${o.pagesFetched ?? 0} page${o.pagesFetched === 1 ? "" : "s"}`];
  if (o.baseline) parts.push("first scan recorded as a baseline (no alerts)");
  else if (o.alertsCreated) parts.push("alerts sent");
  if (o.deferred) parts.push(`${o.deferred} more section${o.deferred === 1 ? "" : "s"} will be reviewed on the next scan`);
  return `Scan complete: ${parts.join("; ")}.`;
}

/**
 * Starts a competitor scan and polls its JobRun (only while it is PENDING or
 * PROCESSING), then reports the outcome and refreshes competitor data.
 */
export function ScanButton({
  competitorId,
  activeJobId,
  disabled,
  size = "sm",
  variant = "outline",
}: {
  competitorId: string;
  activeJobId?: string | null;
  disabled?: boolean;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}) {
  const utils = trpc.useUtils();
  const [jobId, setJobId] = useState<string | null>(activeJobId ?? null);
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (activeJobId) setJobId(activeJobId);
  }, [activeJobId]);

  const run = trpc.competitive.runScan.useMutation({
    onSuccess: (res) => {
      setJobId(res.jobRunId);
      toast.info(res.alreadyRunning ? "A scan is already running for this competitor." : "Scan started. This can take a minute.");
    },
  });

  const job = trpc.job.get.useQuery(
    { id: jobId ?? "" },
    {
      enabled: !!jobId,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return !status || status === "PENDING" || status === "PROCESSING" ? 3_000 : false;
      },
    }
  );

  const status = job.data?.status;
  useEffect(() => {
    if (!jobId) return;
    if (job.isError) {
      setJobId(null);
      return;
    }
    if ((status === "READY" || status === "FAILED") && reported.current !== jobId) {
      reported.current = jobId;
      if (status === "READY") toast.success(summary(job.data?.output));
      else toast.error(job.data?.errorMessage ?? "The scan failed.");
      setJobId(null);
      void utils.competitive.invalidate();
    }
  }, [status, jobId, job.isError, job.data, utils]);

  const scanning = run.isPending || !!jobId;
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      disabled={disabled || scanning}
      onClick={() => run.mutate({ id: competitorId })}
      aria-live="polite"
    >
      {scanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Radar className="mr-2 h-4 w-4" aria-hidden />}
      {scanning ? "Scanning…" : "Scan now"}
    </Button>
  );
}
