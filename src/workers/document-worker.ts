/**
 * Worker for QUEUE.DOCUMENTS: parse, chunk and embed one document (see
 * src/server/ai/pipeline/processor.ts). The producer (upload confirm, retry,
 * URL import, integrations, voice) created the Document row; this worker moves
 * that same row to READY, or to FAILED on the final failed attempt.
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { markDocumentFailed, processDocument } from "@/server/ai/pipeline/processor";

export const documentWorker = defineWorker({
  queue: QUEUE.DOCUMENTS,
  concurrency: 3,
  handler: async ({ documentId }, ctx) => {
    await ctx.updateProgress(5);
    const result = await processDocument(documentId, ctx.log);
    await ctx.updateProgress(100);
    return result;
  },
  onFinalFailure: async ({ documentId }, error) => {
    await markDocumentFailed(documentId, error);
  },
});
