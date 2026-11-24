/**
 * Worker for QUEUE.SYNTHESIS: runs the map-reduce synthesis for the Synthesis
 * row created by synthesis.run, moving that same row PROCESSING → READY, or to
 * FAILED on the final failed attempt (see src/server/ai/synthesis).
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { markSynthesisFailed, runSynthesis } from "@/server/ai/synthesis";

export const synthesisWorker = defineWorker({
  queue: QUEUE.SYNTHESIS,
  concurrency: 2,
  handler: async ({ synthesisId }, ctx) => {
    await ctx.updateProgress(2);
    const result = await runSynthesis(synthesisId, ctx.log, ctx.updateProgress);
    await ctx.updateProgress(100);
    return result;
  },
  onFinalFailure: async ({ synthesisId }, error) => {
    await markSynthesisFailed(synthesisId, error);
  },
});
