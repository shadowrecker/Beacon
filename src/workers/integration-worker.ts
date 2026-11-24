/**
 * Worker for QUEUE.INTEGRATION_SYNC: runs the sync engine against the
 * IntegrationSync row the producer created (src/server/integrations/sync.ts).
 * Provider 429s are retried with backoff by the job framework; auth failures are
 * final and mark the integration as needing a reconnect.
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { markSyncFailed, runIntegrationSync } from "@/server/integrations/sync";

export const integrationWorker = defineWorker({
  queue: QUEUE.INTEGRATION_SYNC,
  concurrency: 3,
  handler: async (data, ctx) => runIntegrationSync(data, { log: ctx.log }),
  onFinalFailure: async (data, err) => markSyncFailed(data, err),
});
