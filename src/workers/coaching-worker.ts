/**
 * Worker for QUEUE.COACHING: generates AI coach insights for one COACHING
 * JobRun (requested by a user, triggered by project activity, or the weekday
 * digest). See src/server/ai/coach/generate.ts.
 */
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage } from "@/server/jobs/worker";
import { runCoaching } from "@/server/ai/coach/generate";

export const coachingWorker = defineWorker({
  queue: QUEUE.COACHING,
  concurrency: 2,
  handler: async ({ jobRunId }, ctx) => runCoaching(jobRunId, ctx.log),
  onFinalFailure: async ({ jobRunId }, error) => {
    await prisma.jobRun.updateMany({
      where: { id: jobRunId, kind: "COACHING", status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: failureMessage(error), completedAt: new Date() },
    });
  },
});
