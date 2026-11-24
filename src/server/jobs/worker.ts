/**
 * Shared worker wrapper. Every background job runs through `runJob`, which:
 *
 * - validates the payload against the queue schema (invalid -> unrecoverable),
 * - classifies errors: NonRetryableError, zod errors and 4xx API errors are not
 *   retried; everything else is retried per the queue's policy,
 * - calls `onFinalFailure` exactly once when the job will not be retried again, so
 *   the owning row is moved to a terminal FAILED state (never left PROCESSING),
 * - logs with jobId/queue bindings.
 *
 * Handlers are plain async functions so tests can call them directly.
 */
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { ZodError } from "zod";
import { createBullConnection } from "@/lib/redis";
import { logger, type Logger } from "@/lib/logger";
import { PAYLOADS, type Payload, type QueueName } from "./queues";

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export interface JobContext {
  jobId: string;
  attempt: number;
  maxAttempts: number;
  log: Logger;
  updateProgress(pct: number): Promise<void>;
}

export interface WorkerDefinition<Q extends QueueName> {
  queue: Q;
  concurrency?: number;
  limiter?: { max: number; duration: number };
  handler(data: Payload<Q>, ctx: JobContext): Promise<unknown>;
  /** Mark the owning row FAILED. Must be idempotent. */
  onFinalFailure?(data: Payload<Q>, error: Error): Promise<void>;
}

export function defineWorker<Q extends QueueName>(def: WorkerDefinition<Q>): WorkerDefinition<Q> {
  return def;
}

export function isNonRetryable(err: unknown): boolean {
  if (err instanceof NonRetryableError || err instanceof ZodError || err instanceof UnrecoverableError) return true;
  const status = (err as { status?: number })?.status;
  // 4xx from an upstream API is a request problem; retrying won't help (except 408/409/429).
  return typeof status === "number" && status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

/**
 * Safe, user-presentable error text for storing on a FAILED row. Upstream API
 * errors (status-bearing errors from the Anthropic/OpenAI SDKs, Deepgram, etc.)
 * are mapped to generic messages: their raw text can include provider details,
 * request IDs or partially masked credentials and must not reach end users.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof NonRetryableError) return err.message;
  if (err instanceof ZodError) return "Invalid job input";
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    if (status === 401 || status === 403) {
      return `An external service rejected Beacon's credentials (HTTP ${status}). An administrator needs to check the service configuration.`;
    }
    if (status === 429) return "An external service is rate limiting requests (HTTP 429). Please try again later.";
    if (status >= 500) return `An external service is temporarily unavailable (HTTP ${status}). Please try again later.`;
    if (status >= 400) return `An external service rejected the request (HTTP ${status}).`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}

export async function runJob<Q extends QueueName>(
  def: WorkerDefinition<Q>,
  raw: unknown,
  meta: { jobId: string; attempt: number; maxAttempts: number; updateProgress?: (n: number) => Promise<void> }
): Promise<unknown> {
  const log = logger.child({ queue: def.queue, jobId: meta.jobId, attempt: meta.attempt });
  const parsed = PAYLOADS[def.queue].safeParse(raw);
  if (!parsed.success) {
    log.error("invalid job payload", { issues: parsed.error.issues });
    throw new UnrecoverableError("Invalid job payload");
  }
  const data = parsed.data as Payload<Q>;
  const ctx: JobContext = {
    jobId: meta.jobId,
    attempt: meta.attempt,
    maxAttempts: meta.maxAttempts,
    log,
    updateProgress: async (pct) => {
      await meta.updateProgress?.(Math.max(0, Math.min(100, Math.round(pct))));
    },
  };

  const started = Date.now();
  try {
    const result = await def.handler(data, ctx);
    log.info("job completed", { ms: Date.now() - started });
    return result;
  } catch (err) {
    const nonRetryable = isNonRetryable(err);
    const final = nonRetryable || meta.attempt >= meta.maxAttempts;
    log.error("job failed", { err, final, nonRetryable, ms: Date.now() - started });
    if (final && def.onFinalFailure) {
      try {
        await def.onFinalFailure(data, err instanceof Error ? err : new Error(String(err)));
      } catch (markErr) {
        log.error("onFinalFailure failed", { err: markErr });
      }
    }
    if (nonRetryable && !(err instanceof UnrecoverableError)) {
      throw new UnrecoverableError(failureMessage(err));
    }
    throw err;
  }
}

/** Start a BullMQ worker for a definition. */
export function startWorker<Q extends QueueName>(def: WorkerDefinition<Q>): Worker {
  const worker = new Worker(
    def.queue,
    async (job: Job) =>
      runJob(def, job.data, {
        jobId: job.id ?? "unknown",
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? 1,
        updateProgress: (n) => job.updateProgress(n),
      }),
    {
      connection: createBullConnection(),
      concurrency: def.concurrency ?? 2,
      limiter: def.limiter,
      // Jobs that run long LLM calls must keep their lock renewed.
      lockDuration: 120_000,
    }
  );
  worker.on("error", (err) => logger.error("worker error", { queue: def.queue, err }));
  return worker;
}
