/**
 * Atomic fixed-window rate limiting on Redis.
 *
 * INCR and PEXPIRE run in one Lua script, so a key can never be left without a
 * TTL (which would lock a user out forever). Callers choose fail-closed (the
 * default, used for LLM-cost endpoints) or fail-open when Redis is unavailable.
 */
import { getRedis } from "./redis";
import { logger } from "./logger";

const SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

export interface RateLimitRule {
  /** Logical bucket name, e.g. "llm:query". */
  name: string;
  limit: number;
  windowMs: number;
  /** When Redis is unreachable: deny (true, default) or allow (false). */
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export async function checkRateLimit(rule: RateLimitRule, subject: string): Promise<RateLimitResult> {
  const key = `rl:${rule.name}:${subject}`;
  try {
    const [count, ttl] = (await getRedis().eval(SCRIPT, 1, key, String(rule.windowMs))) as [number, number];
    return {
      allowed: count <= rule.limit,
      remaining: Math.max(0, rule.limit - count),
      resetMs: ttl > 0 ? ttl : rule.windowMs,
    };
  } catch (err) {
    logger.error("rate limiter unavailable", { rule: rule.name, err });
    const failClosed = rule.failClosed ?? true;
    return { allowed: !failClosed, remaining: 0, resetMs: rule.windowMs };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Per-user limits for tRPC procedures, keyed by procedure tag. */
export const RATE_LIMITS = {
  /** Synchronous or enqueued LLM work. */
  llm: { name: "llm", limit: 30, windowMs: MINUTE },
  llmHourly: { name: "llm-hourly", limit: 300, windowMs: HOUR },
  /** Ordinary writes. */
  write: { name: "write", limit: 120, windowMs: MINUTE, failClosed: false },
  /** Outbound side effects (emails, invites, webhooks tests). */
  outbound: { name: "outbound", limit: 20, windowMs: MINUTE },
  /** Uploads (presign requests). */
  upload: { name: "upload", limit: 60, windowMs: MINUTE },
} satisfies Record<string, RateLimitRule>;
