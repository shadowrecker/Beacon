/**
 * Fans a domain event out to every subscriber that handles its type.
 *
 * Per-subscriber completion is recorded in Redis (7 days), so when one
 * subscriber fails and the job retries, subscribers that already succeeded are
 * skipped. The event is marked dispatched only when all subscribers succeed.
 */
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import type { Logger } from "@/lib/logger";
import type { Subscriber } from "./types";
import { workflowsSubscriber } from "./subscribers/workflows";
import { webhooksSubscriber } from "./subscribers/webhooks";
import { notificationsSubscriber } from "./subscribers/notifications";
import { teamActivitySubscriber } from "./subscribers/team-activity";
import { coachSubscriber } from "./subscribers/coach";
import { knowledgeSubscriber } from "./subscribers/knowledge";
import { outcomesSubscriber } from "./subscribers/outcomes";

export const SUBSCRIBERS: Subscriber[] = [
  workflowsSubscriber,
  webhooksSubscriber,
  notificationsSubscriber,
  teamActivitySubscriber,
  coachSubscriber,
  knowledgeSubscriber,
  outcomesSubscriber,
];

const DONE_TTL_SEC = 7 * 24 * 3600;

export async function dispatchEvent(eventId: string, log: Logger, subscribers: Subscriber[] = SUBSCRIBERS): Promise<void> {
  const event = await prisma.domainEvent.findUnique({ where: { id: eventId } });
  if (!event) {
    log.warn("event not found; skipping", { eventId });
    return;
  }
  if (event.dispatchedAt) return;

  const doneKey = `evt:${event.id}:done`;
  const redis = getRedis();
  const done = new Set(await redis.smembers(doneKey).catch(() => [] as string[]));
  const failures: string[] = [];

  for (const sub of subscribers) {
    if (!sub.handles(event.type) || done.has(sub.name)) continue;
    try {
      await sub.handle(event, log.child({ subscriber: sub.name }));
      await redis.multi().sadd(doneKey, sub.name).expire(doneKey, DONE_TTL_SEC).exec().catch(() => undefined);
    } catch (err) {
      failures.push(sub.name);
      log.error("subscriber failed", { subscriber: sub.name, eventId: event.id, type: event.type, err });
    }
  }

  if (failures.length > 0) {
    throw new Error(`Subscribers failed for event ${event.id}: ${failures.join(", ")}`);
  }
  await prisma.domainEvent.update({ where: { id: event.id }, data: { dispatchedAt: new Date() } });
}
