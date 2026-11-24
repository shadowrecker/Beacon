/**
 * Asynchronous coaching triggers shared by the event subscriber and the weekday
 * digest. A run is a COACHING JobRun with a deterministic ID per project and
 * time bucket, so concurrent or redelivered triggers create one row and one
 * job; a project gets at most one automatic run per interval.
 */
import { prisma } from "@/lib/db";
import { enqueue, QUEUE } from "../../jobs/queues";

export const AUTO_COACHING_INTERVAL_HOURS = Number(process.env.COACH_AUTO_INTERVAL_HOURS ?? "6");
const HOUR = 3_600_000;

export type AutoTrigger = "event" | "digest";

/**
 * Create (if due) and enqueue an automatic coaching run for a project.
 * Returns the JobRun ID, or null when a run already happened within the interval.
 */
export async function scheduleAutoCoaching(input: { orgId: string; projectId: string; trigger: AutoTrigger; eventType?: string; now?: Date }): Promise<string | null> {
  const now = input.now ?? new Date();
  const intervalMs = Math.max(1, AUTO_COACHING_INTERVAL_HOURS) * HOUR;
  const recent = await prisma.jobRun.findFirst({
    where: { projectId: input.projectId, kind: "COACHING", createdById: null, createdAt: { gt: new Date(now.getTime() - intervalMs) } },
    select: { id: true },
  });
  if (recent) return null;

  const bucket = Math.floor(now.getTime() / intervalMs);
  const id = `coach_${input.trigger}_${input.projectId}_${bucket}`;
  await prisma.jobRun.upsert({
    where: { id },
    create: {
      id,
      kind: "COACHING",
      orgId: input.orgId,
      projectId: input.projectId,
      status: "PENDING",
      input: { trigger: input.trigger, ...(input.eventType ? { eventType: input.eventType } : {}) },
    },
    update: {},
  });
  await enqueue(QUEUE.COACHING, { jobRunId: id }, { jobId: id });
  return id;
}
