/**
 * Worker process entry point.
 *
 * Starts one BullMQ worker per queue (WORKERS registry), registers the
 * maintenance repeat schedules, serves liveness/readiness on WORKER_HEALTH_PORT
 * (default 9464), and shuts down gracefully: on SIGTERM/SIGINT every worker
 * stops taking new jobs and in-flight jobs get up to SHUTDOWN_GRACE_MS to finish.
 */
import http from "node:http";
import type { Worker } from "bullmq";
import { assertServerEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/db";
import { closeRedis, getRedis } from "@/lib/redis";
import { closeQueues, getQueue, QUEUE } from "@/server/jobs/queues";
import { startWorker } from "@/server/jobs/worker";
import { registerAICustomization } from "@/server/ai/custom/hook";
import { WORKERS } from "./registry";
import { MAINTENANCE_SCHEDULES } from "./maintenance-worker";

const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 120_000);
const log = logger.child({ component: "workers" });

let workers: Worker[] = [];
let shuttingDown = false;
let lastHeartbeat = Date.now();

async function registerSchedules(): Promise<void> {
  const q = getQueue(QUEUE.MAINTENANCE);
  for (const s of MAINTENANCE_SCHEDULES) {
    await q.upsertJobScheduler(`maintenance:${s.task}`, { pattern: s.every }, { name: QUEUE.MAINTENANCE, data: { task: s.task } });
  }
}

function startHealthServer(): http.Server {
  const port = Number(process.env.WORKER_HEALTH_PORT ?? 9464);
  const server = http.createServer(async (req, res) => {
    if (req.url === "/live") {
      const ok = !shuttingDown && Date.now() - lastHeartbeat < 60_000;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ok ? "ok" : "unavailable" }));
      return;
    }
    if (req.url === "/ready") {
      try {
        await prisma.$queryRaw`SELECT 1`;
        await getRedis().ping();
        const running = workers.filter((w) => w.isRunning()).length;
        const ok = !shuttingDown && running === workers.length;
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: ok ? "ok" : "unavailable", workers: running }));
      } catch {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "unavailable" }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, () => log.info("worker health server listening", { port }));
  return server;
}

async function shutdown(signal: string, health: http.Server): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down workers", { signal, graceMs: SHUTDOWN_GRACE_MS });
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  await Promise.race([Promise.all(workers.map((w) => w.close())), deadline]);
  await Promise.allSettled([closeQueues(), closeRedis(), prisma.$disconnect()]);
  health.close();
  log.info("workers stopped");
  process.exit(0);
}

async function main(): Promise<void> {
  assertServerEnv();
  registerAICustomization();
  workers = WORKERS.map((def) => startWorker(def));
  await registerSchedules();
  const health = startHealthServer();
  setInterval(() => {
    lastHeartbeat = Date.now();
  }, 10_000).unref();

  process.on("SIGTERM", () => void shutdown("SIGTERM", health));
  process.on("SIGINT", () => void shutdown("SIGINT", health));
  process.on("unhandledRejection", (reason) => {
    // Log, but don't kill every worker for one stray promise.
    log.error("unhandled rejection", { err: reason });
  });
  log.info("workers started", { queues: WORKERS.map((w) => w.queue) });
}

main().catch((err) => {
  log.error("worker process failed to start", { err });
  process.exit(1);
});
