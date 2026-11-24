"use client";

/**
 * Poll a JobRun (`job.get`) while it is PENDING/PROCESSING and stop on READY or
 * FAILED, calling `onReady` / `onFailed` once per run.
 */
import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc/client";

export type JobRunStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";

export function useJobRun(
  jobRunId: string | null,
  handlers: { onReady?: (output: unknown) => void; onFailed?: (message: string) => void } = {},
  intervalMs = 2_000
) {
  const query = trpc.job.get.useQuery(
    { id: jobRunId ?? "" },
    {
      enabled: !!jobRunId,
      refetchInterval: (q) => {
        const s = q.state.data?.status;
        return s === "READY" || s === "FAILED" ? false : intervalMs;
      },
    }
  );
  const handled = useRef<string | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const data = jobRunId ? query.data : undefined;
  useEffect(() => {
    if (!jobRunId || !data || data.id !== jobRunId || handled.current === jobRunId) return;
    if (data.status === "READY") {
      handled.current = jobRunId;
      handlersRef.current.onReady?.(data.output);
    } else if (data.status === "FAILED") {
      handled.current = jobRunId;
      handlersRef.current.onFailed?.(data.errorMessage ?? "The job failed. Please try again.");
    }
  }, [jobRunId, data]);

  const status: JobRunStatus | null = jobRunId ? ((data?.status as JobRunStatus | undefined) ?? "PENDING") : null;
  return {
    status,
    isRunning: status === "PENDING" || status === "PROCESSING",
    isError: query.isError,
  };
}
