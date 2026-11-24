/**
 * Worker for QUEUE.COMPETITIVE_SCAN: scans one competitor's website
 * (src/server/ai/competitive). Updates the JobRun created by competitive.runScan
 * when present; scheduled scans have no JobRun and only update the competitor.
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { markScanFailed, runCompetitorScan } from "@/server/ai/competitive";

export const competitiveWorker = defineWorker({
  queue: QUEUE.COMPETITIVE_SCAN,
  concurrency: 2,
  handler: async (data, ctx) => runCompetitorScan(data, ctx.log),
  onFinalFailure: async (data, err) => markScanFailed(data, err),
});
