/**
 * Competitor monitoring schedule (maintenance task "schedule-competitive",
 * every 6 hours): enqueue a scan for every competitor with a website or capture
 * URL that hasn't been scanned in 24 hours. The job id is per competitor per
 * day, so overlapping runs never double-scan.
 */
import { prisma } from "@/lib/db";
import { enqueue, QUEUE } from "../jobs/queues";

export const SCAN_EVERY_MS = 24 * 3600_000;
const BATCH = 500;

export async function run(now = new Date()): Promise<number> {
  const due = await prisma.competitorProfile.findMany({
    where: {
      OR: [{ website: { not: null } }, { captureUrl: { not: null } }],
      AND: [{ OR: [{ lastScannedAt: null }, { lastScannedAt: { lt: new Date(now.getTime() - SCAN_EVERY_MS) } }] }],
    },
    select: { id: true },
    orderBy: [{ lastScannedAt: { sort: "asc", nulls: "first" } }],
    take: BATCH,
  });
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  for (const c of due) {
    await enqueue(QUEUE.COMPETITIVE_SCAN, { competitorId: c.id }, { jobId: `compscan_${c.id}_${day}` });
  }
  return due.length;
}
