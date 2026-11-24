/**
 * Scheduled integration sync (maintenance task "schedule-integrations", every 30 min).
 *
 * Enqueues a sync for every CONNECTED integration with a target project whose
 * last sync is older than its interval (config.syncIntervalMinutes, default 6h),
 * or sooner when the previous sync stopped at its page cap with more data
 * pending. The sync row id is deterministic per interval slot, so overlapping
 * scheduler runs can never create two syncs for the same slot.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { startSync } from "../integrations/service";
import { DEFAULT_SYNC_INTERVAL_MINUTES, readStoredCursor } from "../integrations/sync";

const BATCH = 500;
/** Follow-up delay for integrations with more data pending. */
const CONTINUE_AFTER_MINUTES = 15;

function intervalMinutes(config: unknown): number {
  const raw = Number((config as { syncIntervalMinutes?: unknown } | null)?.syncIntervalMinutes);
  return Number.isFinite(raw) && raw >= 60 && raw <= 10_080 ? raw : DEFAULT_SYNC_INTERVAL_MINUTES;
}

export async function run(now = new Date()): Promise<number> {
  const integrations = await prisma.integration.findMany({
    where: { status: "CONNECTED", projectId: { not: null }, credentialsEncrypted: { not: null } },
    select: { id: true, config: true, lastSyncAt: true, syncCursor: true },
    orderBy: [{ lastSyncAt: { sort: "asc", nulls: "first" } }],
    take: BATCH,
  });

  let enqueued = 0;
  for (const integ of integrations) {
    const interval = intervalMinutes(integ.config);
    const { hasMore } = readStoredCursor(integ.syncCursor);
    const dueAfter = (hasMore ? Math.min(interval, CONTINUE_AFTER_MINUTES) : interval) * 60_000;
    if (integ.lastSyncAt && now.getTime() - integ.lastSyncAt.getTime() < dueAfter) continue;

    const busy = await prisma.integrationSync.findFirst({
      where: { integrationId: integ.id, status: { in: ["PENDING", "RUNNING"] } },
      select: { id: true },
    });
    if (busy) continue;

    const slot = Math.floor(now.getTime() / dueAfter);
    const syncId = `sched${integ.id}${slot.toString(36)}`;
    try {
      await startSync(integ.id, { syncId });
      enqueued++;
    } catch (err) {
      // Unique violation: this slot was already scheduled.
      if ((err as { code?: string }).code === "P2002") continue;
      logger.error("failed to schedule integration sync", { integrationId: integ.id, err });
    }
  }
  return enqueued;
}
