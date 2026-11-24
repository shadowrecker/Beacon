/**
 * Worker for QUEUE.HANDOFF.
 *
 * Pushes a recommendation's handoff document to Jira or Linear through the
 * project's own org integration (credentials resolved server-side from the
 * JobRun's org, never from job input), then stores the issue key and URL in
 * THAT JobRun's output.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { handoffRunInputSchema, handoffRunOutputSchema, prepareHandoff, pushHandoff } from "@/server/ai/handoff/exporter";

export const handoffWorker = defineWorker({
  queue: QUEUE.HANDOFF,
  concurrency: 2,
  handler: async ({ jobRunId }, ctx) => {
    const run = await prisma.jobRun.findUnique({
      where: { id: jobRunId },
      select: { id: true, kind: true, status: true, orgId: true, projectId: true, input: true, output: true },
    });
    if (!run || run.kind !== "HANDOFF_EXPORT" || !run.projectId) throw new NonRetryableError("Handoff export not found");
    if (run.status === "READY" || run.status === "FAILED") return { status: run.status, skipped: true };
    const input = handoffRunInputSchema.safeParse(run.input);
    if (!input.success) throw new NonRetryableError("Invalid handoff export request");

    // The org comes from the project the run belongs to (and must match the run's org).
    const project = await prisma.project.findUnique({ where: { id: run.projectId }, select: { id: true, orgId: true } });
    if (!project || project.orgId !== run.orgId) throw new NonRetryableError("Project not found");

    // An earlier attempt already created the issue but failed before finishing.
    const previous = handoffRunOutputSchema.safeParse(run.output);
    if (previous.success) {
      await prisma.jobRun.update({ where: { id: run.id }, data: { status: "READY", completedAt: new Date(), errorMessage: null } });
      return previous.data;
    }

    await prisma.jobRun.update({ where: { id: run.id }, data: { status: "PROCESSING", startedAt: new Date(), errorMessage: null } });
    const doc = await prepareHandoff({ recommendationId: input.data.recommendationId, projectId: project.id, orgId: project.orgId });
    await ctx.updateProgress(50);

    const output = await pushHandoff(project.orgId, input.data, doc);
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: "READY", output: output as unknown as Prisma.InputJsonValue, completedAt: new Date(), errorMessage: null },
    });
    return output;
  },
  onFinalFailure: async ({ jobRunId }, error) => {
    await prisma.jobRun.updateMany({
      where: { id: jobRunId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: failureMessage(error), completedAt: new Date() },
    });
  },
});
