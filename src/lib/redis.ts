/**
 * Redis connections, all derived from REDIS_URL (supports redis:// and rediss://
 * with username/password, so managed Redis with TLS and auth works).
 *
 * - getRedis(): shared command connection (rate limiting, caches, health).
 * - createBullConnection(): a fresh connection for BullMQ Workers/Queues, which
 *   require maxRetriesPerRequest: null.
 */
import { Redis, type RedisOptions } from "ioredis";
import { logger } from "./logger";

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not configured");
  return url;
}

let shared: Redis | null = null;

export function getRedis(): Redis {
  if (!shared) {
    shared = new Redis(redisUrl(), {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
      connectTimeout: 5_000,
      lazyConnect: false,
    });
    shared.on("error", (err) => logger.error("redis error", { err }));
  }
  return shared;
}

export function createBullConnection(extra: RedisOptions = {}): Redis {
  const conn = new Redis(redisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...extra,
  });
  conn.on("error", (err) => logger.error("redis (bullmq) error", { err }));
  return conn;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit().catch(() => shared?.disconnect());
    shared = null;
  }
}
