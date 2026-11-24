/**
 * Worker for QUEUE.WORKFLOWS: runs one workflow for one event
 * (or one manual run tracked by a JobRun). See src/server/workflows/engine.ts.
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { failWorkflowJob, runWorkflowJob } from "@/server/workflows/engine";

export const workflowWorker = defineWorker({
  queue: QUEUE.WORKFLOWS,
  concurrency: 4,
  handler: (data, ctx) => runWorkflowJob(data, ctx),
  onFinalFailure: (data, err) =>
    // Only deliberate, user-presentable messages are stored; internals stay in logs.
    failWorkflowJob(data, err instanceof NonRetryableError ? failureMessage(err) : "The workflow run failed unexpectedly. Please try again."),
});
