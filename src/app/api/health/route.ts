/**
 * Readiness probe: verifies the database and Redis are reachable, with short
 * timeouts and generic output (no error details to unauthenticated callers).
 * Liveness (process is up) is /api/health/live.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

export async function GET() {
  const checks: Record<string, "ok" | "fail"> = { database: "ok", redis: "ok" };
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2_000);
  } catch (err) {
    checks.database = "fail";
    logger.error("readiness: database check failed", { err });
  }
  try {
    await withTimeout(getRedis().ping(), 2_000);
  } catch (err) {
    checks.redis = "fail";
    logger.error("readiness: redis check failed", { err });
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json(
    { status: healthy ? "ok" : "unavailable", checks },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
