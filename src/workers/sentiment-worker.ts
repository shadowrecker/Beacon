/**
 * Worker for QUEUE.SENTIMENT: one sentiment + churn-risk analysis run for a
 * project period (see src/server/ai/sentiment/run.ts). Manual runs carry the
 * JobRun created by sentiment.runAnalysis; scheduled runs have none.
 */
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage } from "@/server/jobs/worker";
import { runSentimentAnalysis } from "@/server/ai/sentiment/run";

export const sentimentWorker = defineWorker({
  queue: QUEUE.SENTIMENT,
  concurrency: 2,
  handler: async (data, ctx) => runSentimentAnalysis(data, ctx.log, ctx.updateProgress),
  onFinalFailure: async (data, error) => {
    if (!data.jobRunId) return;
    await prisma.jobRun.updateMany({
      where: { id: data.jobRunId, projectId: data.projectId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: failureMessage(error), completedAt: new Date() },
    });
  },
});
