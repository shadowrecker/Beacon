/**
 * Create in-app notifications and (per user preference) queue an email.
 *
 * In-app always; email for the types below unless the user turned
 * that type's email off in `User.notificationPrefs` ({"TYPE": {"email": false}}).
 * Email delivery itself is the EMAIL queue (src/workers/email-worker.ts).
 */
import type { NotificationType } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { enqueue, QUEUE } from "../jobs/queues";

/** Notification types that email by default (users can opt out per type). */
export const EMAIL_BY_DEFAULT: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "COMMENT_MENTION",
  "ORG_INVITE",
  "SENTIMENT_ALERT",
  "COMPETITOR_ALERT",
]);

export interface NotifyInput {
  userIds: string[];
  type: NotificationType;
  title: string;
  message: string;
  resourceType?: string;
  resourceId?: string;
  /** Link (path) shown in the email. */
  href?: string;
  /** Stable key so a retried producer never notifies twice. */
  dedupeKey: string;
}

const DEDUPE_TTL_SEC = 7 * 24 * 3600;

/** True the first time `marker` is seen (Redis SET NX); true when Redis is down. */
async function claimOnce(marker: string): Promise<boolean> {
  try {
    const res = await getRedis().set(`notif:dedupe:${marker}`, "1", "EX", DEDUPE_TTL_SEC, "NX");
    return res === "OK";
  } catch {
    return true;
  }
}

function emailEnabled(prefs: unknown, type: NotificationType): boolean {
  const p = (prefs ?? {}) as Record<string, { email?: boolean } | undefined>;
  const explicit = p[type]?.email;
  return explicit ?? EMAIL_BY_DEFAULT.has(type);
}

export async function notify(input: NotifyInput, db: DbClient = prisma): Promise<number> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) return 0;
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, notificationPrefs: true },
  });

  let created = 0;
  for (const u of users) {
    // Idempotency: one notification per (user, dedupeKey), claimed atomically in
    // Redis for 7 days. If Redis is unavailable, fall back to a content match.
    const marker = `${input.dedupeKey}:${u.id}`;
    if (!(await claimOnce(marker))) continue;
    const exists = await db.notification.findFirst({ where: { userId: u.id, resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null, title: input.title, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, select: { id: true } });
    if (exists) continue;
    await db.notification.create({
      data: {
        userId: u.id,
        type: input.type,
        title: input.title.slice(0, 200),
        message: input.message.slice(0, 2000),
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
      },
    });
    created++;
    if (u.email && emailEnabled(u.notificationPrefs, input.type)) {
      await enqueue(
        QUEUE.EMAIL,
        {
          to: u.email,
          template: input.type === "COMMENT_MENTION" ? "mention" : "notification",
          data: { title: input.title, message: input.message, href: input.href ?? null },
          dedupeKey: marker,
        },
        { jobId: `email_${marker}` }
      );
    }
  }
  return created;
}
