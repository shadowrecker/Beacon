/**
 * Coach scheduler (maintenance task "schedule-coach", weekdays 08:45 UTC):
 * a digest coaching run for each project with activity in the last 7 days,
 * bounded per tick. Projects that already had an automatic run within the
 * coaching interval are skipped. Returns the number of runs enqueued.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { scheduleAutoCoaching } from "../ai/coach/schedule";

const ACTIVE_WINDOW_MS = 7 * 86_400_000;
const MAX_PROJECTS_PER_TICK = 500;

export async function run(now: Date = new Date()): Promise<number> {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return 0;
  const since = new Date(now.getTime() - ACTIVE_WINDOW_MS);
  const projects = await prisma.project.findMany({
    where: {
      OR: [
        { documents: { some: { createdAt: { gte: since } } } },
        { recommendations: { some: { updatedAt: { gte: since } } } },
        { syntheses: { some: { createdAt: { gte: since } } } },
        { decisionLogs: { some: { createdAt: { gte: since } } } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: MAX_PROJECTS_PER_TICK,
    select: { id: true, orgId: true },
  });
  let enqueued = 0;
  for (const p of projects) {
    const id = await scheduleAutoCoaching({ orgId: p.orgId, projectId: p.id, trigger: "digest", now });
    if (id) enqueued++;
  }
  if (enqueued > 0) logger.info("coach digests scheduled", { enqueued, considered: projects.length });
  return enqueued;
}
