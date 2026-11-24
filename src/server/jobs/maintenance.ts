/**
 * Periodic maintenance tasks.
 *
 * - sweepStuckJobs: moves rows stuck in a non-terminal state past their deadline
 *   to FAILED, so the UI never spins forever (the plan's "every job reaches a
 *   terminal state" requirement).
 * - applyRetention: deletes operational data past its retention window.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** How long a job may stay non-terminal before it is considered stuck. */
export const STUCK_AFTER_MS = {
  document: 60 * MIN,
  synthesis: 60 * MIN,
  gapAnalysis: 30 * MIN,
  jobRun: 60 * MIN,
  voice: 90 * MIN,
  presentation: 30 * MIN,
  integrationSync: 3 * HOUR,
} as const;

const STUCK_MESSAGE = "Processing timed out. Please try again.";

/** Uploads that were started (presigned URL issued) but never confirmed. */
export const ABANDONED_UPLOAD_AFTER_MS = 24 * HOUR;
const AWAITING_UPLOAD = { metadata: { path: ["awaitingUpload"], equals: true } } as const;

/**
 * Delete document rows whose upload was never confirmed, and any object the
 * client may have uploaded without confirming. These are not "failed jobs":
 * no processing was ever requested.
 */
export async function cleanupAbandonedUploads(now = new Date()): Promise<number> {
  const rows = await prisma.document.findMany({
    where: {
      status: "PENDING",
      ...AWAITING_UPLOAD,
      createdAt: { lt: new Date(now.getTime() - ABANDONED_UPLOAD_AFTER_MS) },
    },
    select: { id: true, storageKey: true },
    take: 500,
  });
  if (rows.length === 0) return 0;
  const { getStorage } = await import("@/lib/storage");
  const storage = getStorage();
  for (const r of rows) {
    if (r.storageKey) await storage.delete(r.storageKey).catch((err) => logger.warn("abandoned upload object delete failed", { documentId: r.id, err }));
  }
  const { count } = await prisma.document.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, status: "PENDING", ...AWAITING_UPLOAD } });
  return count;
}

export async function sweepStuckJobs(now = new Date()): Promise<Record<string, number>> {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const [documents, syntheses, gaps, runs, voice, presentations, syncs] = await Promise.all([
    // Raw SQL so missing/NULL metadata counts as "not awaiting upload" (a Prisma
    // NOT on a JSON path filter evaluates to NULL for those rows and skips them).
    // Unconfirmed uploads are cleaned up separately, not marked failed.
    prisma.$executeRaw`
      UPDATE documents
      SET status = 'FAILED', "errorMessage" = ${STUCK_MESSAGE}, "updatedAt" = (now() AT TIME ZONE 'UTC')
      WHERE status IN ('PENDING', 'PROCESSING')
        AND "updatedAt" < ${before(STUCK_AFTER_MS.document)}
        AND COALESCE((metadata ->> 'awaitingUpload')::boolean, false) = false`.then((count) => ({ count })),
    prisma.synthesis.updateMany({
      where: { status: { in: ["PENDING", "PROCESSING"] }, updatedAt: { lt: before(STUCK_AFTER_MS.synthesis) } },
      data: { status: "FAILED", errorMessage: STUCK_MESSAGE },
    }),
    prisma.gapAnalysis.updateMany({
      where: { status: { in: ["PENDING", "PROCESSING"] }, updatedAt: { lt: before(STUCK_AFTER_MS.gapAnalysis) } },
      data: { status: "FAILED", errorMessage: STUCK_MESSAGE },
    }),
    prisma.jobRun.updateMany({
      where: { status: { in: ["PENDING", "PROCESSING"] }, updatedAt: { lt: before(STUCK_AFTER_MS.jobRun) } },
      data: { status: "FAILED", errorMessage: STUCK_MESSAGE, completedAt: now },
    }),
    prisma.voiceRecording.updateMany({
      where: {
        status: { in: ["UPLOADING", "TRANSCRIBING", "ANALYZING"] },
        createdAt: { lt: before(STUCK_AFTER_MS.voice) },
      },
      data: { status: "FAILED", errorMessage: STUCK_MESSAGE },
    }),
    prisma.presentation.updateMany({
      where: { status: "GENERATING", updatedAt: { lt: before(STUCK_AFTER_MS.presentation) } },
      data: { status: "FAILED", errorMessage: STUCK_MESSAGE },
    }),
    prisma.integrationSync.updateMany({
      where: { status: { in: ["PENDING", "RUNNING"] }, startedAt: { lt: before(STUCK_AFTER_MS.integrationSync) } },
      data: { status: "FAILED", errorMessage: STUCK_MESSAGE, completedAt: now },
    }),
  ]);
  const result = {
    documents: documents.count,
    syntheses: syntheses.count,
    gapAnalyses: gaps.count,
    jobRuns: runs.count,
    voiceRecordings: voice.count,
    presentations: presentations.count,
    integrationSyncs: syncs.count,
  };
  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) logger.warn("swept stuck jobs", result);
  return result;
}

export const RETENTION_MS = {
  apiUsage: 90 * DAY,
  webhookDeliveries: 30 * DAY,
  dispatchedEvents: 30 * DAY,
  readNotifications: 180 * DAY,
  workflowRuns: 90 * DAY,
  expiredInvites: 30 * DAY,
} as const;

export async function applyRetention(now = new Date()): Promise<Record<string, number>> {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const [apiUsage, deliveries, events, notifications, runs, invites] = await Promise.all([
    prisma.apiUsage.deleteMany({ where: { timestamp: { lt: before(RETENTION_MS.apiUsage) } } }),
    prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: before(RETENTION_MS.webhookDeliveries) } } }),
    prisma.domainEvent.deleteMany({
      where: { dispatchedAt: { not: null }, createdAt: { lt: before(RETENTION_MS.dispatchedEvents) } },
    }),
    prisma.notification.deleteMany({ where: { isRead: true, createdAt: { lt: before(RETENTION_MS.readNotifications) } } }),
    prisma.workflowRun.deleteMany({ where: { startedAt: { lt: before(RETENTION_MS.workflowRuns) } } }),
    prisma.orgInvite.deleteMany({
      where: { acceptedAt: null, expiresAt: { lt: before(RETENTION_MS.expiredInvites) } },
    }),
  ]);
  return {
    apiUsage: apiUsage.count,
    webhookDeliveries: deliveries.count,
    domainEvents: events.count,
    notifications: notifications.count,
    workflowRuns: runs.count,
    invites: invites.count,
  };
}
