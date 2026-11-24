/**
 * Sentiment scheduler (maintenance task "schedule-sentiment", daily 02:05 UTC).
 *
 * - DAILY: yesterday's window, for every project with READY documents created
 *   in it.
 * - WEEKLY (Mondays): last week's window, for projects with documents in it.
 * - MONTHLY (the 1st): last month's window, likewise.
 *
 * Job IDs are deterministic per (project, period, periodStart), so a repeated
 * scheduler tick never enqueues the same analysis twice. Returns the number of
 * jobs enqueued.
 */
import type { SentimentPeriod } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueue, QUEUE } from "../jobs/queues";
import { lastCompleteWindow, type PeriodWindow } from "../ai/sentiment/periods";

const PAGE = 500;
/** Upper bound on projects scheduled per period per tick. */
const MAX_PROJECTS = 20_000;

async function projectsWithDocumentsIn(window: PeriodWindow): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  while (ids.length < MAX_PROJECTS) {
    const rows = await prisma.project.findMany({
      where: { documents: { some: { status: "READY", createdAt: { gte: window.start, lt: window.end } } } },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true },
    });
    ids.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
    cursor = rows[rows.length - 1].id;
  }
  return ids.slice(0, MAX_PROJECTS);
}

export function periodsDue(now: Date): SentimentPeriod[] {
  const due: SentimentPeriod[] = ["DAILY"];
  if (now.getUTCDay() === 1) due.push("WEEKLY");
  if (now.getUTCDate() === 1) due.push("MONTHLY");
  return due;
}

export async function run(now: Date = new Date()): Promise<number> {
  let enqueued = 0;
  for (const period of periodsDue(now)) {
    const window = lastCompleteWindow(period, now);
    const periodStart = window.start.toISOString();
    const projectIds = await projectsWithDocumentsIn(window);
    for (const projectId of projectIds) {
      await enqueue(QUEUE.SENTIMENT, { projectId, period, periodStart }, { jobId: `sent_${projectId}_${period}_${periodStart}` });
      enqueued++;
    }
    if (projectIds.length > 0) logger.info("sentiment analyses scheduled", { period, periodStart, projects: projectIds.length });
  }
  return enqueued;
}
