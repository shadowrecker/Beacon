/**
 * Worker for QUEUE.RECOMMENDATIONS: generates recommendations for the JobRun
 * created by recommendation.generate, moving that same run to READY (clients
 * poll job.get), or to FAILED on the final failed attempt.
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { markRecommendationsFailed, runRecommendations } from "@/server/ai/recommendations/generator";

export const recommendationWorker = defineWorker({
  queue: QUEUE.RECOMMENDATIONS,
  concurrency: 2,
  handler: async (data, ctx) => {
    await ctx.updateProgress(5);
    const result = await runRecommendations(data, ctx.log);
    await ctx.updateProgress(100);
    return result;
  },
  onFinalFailure: async ({ jobRunId }, error) => {
    await markRecommendationsFailed(jobRunId, error);
  },
});
