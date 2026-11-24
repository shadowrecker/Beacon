/**
 * Lightweight activity signals for the coach, kept in Redis (30-day TTL):
 * per project, how many of each observed event happened per day, and which
 * users acted most recently. Recording is idempotent per event ID. These are
 * hints for choosing insight recipients and describing activity; the coach
 * reads authoritative facts from the database.
 */
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

const TTL_SEC = 30 * 24 * 3600;

export const OBSERVED_EVENTS = [
  "document.ready",
  "synthesis.completed",
  "recommendation.created",
  "recommendation.status_changed",
  "gap.detected",
] as const;
export type ObservedEvent = (typeof OBSERVED_EVENTS)[number];

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const countsKey = (projectId: string, day: string) => `coach:activity:${projectId}:${day}`;
const actorsKey = (projectId: string) => `coach:actors:${projectId}`;
const seenKey = (projectId: string) => `coach:seen:${projectId}`;

export async function recordActivity(input: { eventId: string; projectId: string; type: string; actorUserId: string | null; at: Date }): Promise<void> {
  try {
    const redis = getRedis();
    const added = await redis.sadd(seenKey(input.projectId), input.eventId);
    await redis.expire(seenKey(input.projectId), TTL_SEC);
    if (added === 0) return; // already recorded (redelivered event)
    const multi = redis.multi();
    const ck = countsKey(input.projectId, dayKey(input.at));
    multi.hincrby(ck, input.type, 1).expire(ck, TTL_SEC);
    if (input.actorUserId) {
      multi.zadd(actorsKey(input.projectId), input.at.getTime(), input.actorUserId).expire(actorsKey(input.projectId), TTL_SEC);
      multi.zremrangebyrank(actorsKey(input.projectId), 0, -51); // keep the 50 most recent actors
    }
    await multi.exec();
  } catch (err) {
    logger.warn("coach activity not recorded", { projectId: input.projectId, err });
  }
}

/** Users who acted on the project most recently (newest first). */
export async function recentActors(projectId: string, sinceMs: number, limit = 10): Promise<string[]> {
  try {
    const ids = await getRedis().zrevrangebyscore(actorsKey(projectId), "+inf", Date.now() - sinceMs, "LIMIT", 0, limit);
    return ids;
  } catch (err) {
    logger.warn("coach actors unavailable", { projectId, err });
    return [];
  }
}

/** Event counts per type over the last `days` days. */
export async function activityCounts(projectId: string, days = 14): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const redis = getRedis();
    const multi = redis.multi();
    const now = Date.now();
    for (let i = 0; i < days; i++) multi.hgetall(countsKey(projectId, dayKey(new Date(now - i * 86_400_000))));
    const res = (await multi.exec()) ?? [];
    for (const [err, value] of res) {
      if (err || !value) continue;
      for (const [k, v] of Object.entries(value as Record<string, string>)) out[k] = (out[k] ?? 0) + Number(v);
    }
  } catch (err) {
    logger.warn("coach activity counts unavailable", { projectId, err });
  }
  return out;
}
