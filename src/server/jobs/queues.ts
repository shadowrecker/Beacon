/**
 * Queue registry: the single source of truth for queue names and job payloads.
 *
 * Producers call `enqueue(QUEUE.X, payload)`; workers are registered against the
 * same names (src/workers/index.ts). Payloads are validated on both sides with the
 * schemas below, so a producer/consumer mismatch fails loudly in tests (see the
 * queue contract test) instead of silently dropping jobs.
 */
import { Queue, type JobsOptions } from "bullmq";
import { z } from "zod";
import { createBullConnection } from "@/lib/redis";

export const QUEUE = {
  DOCUMENTS: "document-processing",
  SYNTHESIS: "synthesis",
  RECOMMENDATIONS: "recommendations",
  INTEGRATION_SYNC: "integration-sync",
  COMPETITIVE_SCAN: "competitive-scan",
  GAP_ANALYSIS: "gap-analysis",
  CORRELATION: "correlation-analysis",
  PRESENTATIONS: "presentation-generation",
  SENTIMENT: "sentiment-analysis",
  KNOWLEDGE: "knowledge-extraction",
  VOICE: "voice-processing",
  COACHING: "coaching",
  HANDOFF: "handoff-export",
  WORKFLOWS: "workflow-run",
  DOMAIN_EVENTS: "domain-events",
  WEBHOOKS: "webhook-delivery",
  EMAIL: "email",
  IMPORTS: "data-import",
  MAINTENANCE: "maintenance",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

const id = z.string().min(1).max(64);

export const PAYLOADS = {
  [QUEUE.DOCUMENTS]: z.object({ documentId: id }),
  [QUEUE.SYNTHESIS]: z.object({ synthesisId: id }),
  [QUEUE.RECOMMENDATIONS]: z.object({ jobRunId: id, projectId: id, synthesisId: id.nullable() }),
  [QUEUE.INTEGRATION_SYNC]: z.object({ integrationId: id, syncId: id }),
  [QUEUE.COMPETITIVE_SCAN]: z.object({ competitorId: id, jobRunId: id.optional() }),
  [QUEUE.GAP_ANALYSIS]: z.object({ gapAnalysisId: id }),
  [QUEUE.CORRELATION]: z.object({ jobRunId: id, projectId: id }),
  [QUEUE.PRESENTATIONS]: z.object({ presentationId: id }),
  [QUEUE.SENTIMENT]: z.object({
    projectId: id,
    period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
    /** ISO start of the period; defaults to the most recent complete period. */
    periodStart: z.string().datetime().optional(),
    jobRunId: id.optional(),
  }),
  [QUEUE.KNOWLEDGE]: z.object({ documentId: id }),
  [QUEUE.VOICE]: z.object({ recordingId: id }),
  [QUEUE.COACHING]: z.object({ jobRunId: id }),
  [QUEUE.HANDOFF]: z.object({ jobRunId: id }),
  [QUEUE.WORKFLOWS]: z.object({
    workflowId: id,
    eventId: id.nullable(),
    jobRunId: id.optional(),
  }),
  [QUEUE.DOMAIN_EVENTS]: z.object({ eventId: id }),
  [QUEUE.WEBHOOKS]: z.object({ deliveryId: id }),
  [QUEUE.EMAIL]: z.object({
    to: z.string().email(),
    template: z.enum(["org-invite", "mention", "notification"]),
    data: z.record(z.string(), z.unknown()),
    /** Dedupe key so a retried producer never sends twice. */
    dedupeKey: z.string().max(200),
  }),
  /** Integration-backed roadmap/analytics imports (JobRun kind ROADMAP_IMPORT | ANALYTICS_IMPORT). */
  [QUEUE.IMPORTS]: z.object({ jobRunId: id }),
  [QUEUE.MAINTENANCE]: z.object({
    task: z.enum([
      "sweep-stuck-jobs",
      "retention",
      "schedule-sentiment",
      "schedule-competitive",
      "schedule-integrations",
      "schedule-coach",
    ]),
  }),
} satisfies Record<QueueName, z.ZodType>;

export type Payload<Q extends QueueName> = z.infer<(typeof PAYLOADS)[Q]>;

/** Retry policy per queue. LLM work retries a few times; side effects more. */
const DEFAULTS: Partial<Record<QueueName, JobsOptions>> = {
  [QUEUE.WEBHOOKS]: { attempts: 6, backoff: { type: "exponential", delay: 30_000 } },
  [QUEUE.EMAIL]: { attempts: 5, backoff: { type: "exponential", delay: 15_000 } },
  [QUEUE.DOMAIN_EVENTS]: { attempts: 5, backoff: { type: "exponential", delay: 2_000 } },
  [QUEUE.MAINTENANCE]: { attempts: 1 },
};

const BASE: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function jobOptions(queue: QueueName): JobsOptions {
  return { ...BASE, ...(DEFAULTS[queue] ?? {}) };
}

// ---------------------------------------------------------------------------
// Producer side
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  /** Deterministic id: a second enqueue with the same id is a no-op (dedupe). */
  jobId?: string;
  delayMs?: number;
}

type Transport = <Q extends QueueName>(queue: Q, payload: Payload<Q>, opts: EnqueueOptions) => Promise<void>;

const queues = new Map<QueueName, Queue>();
let sharedConnection: ReturnType<typeof createBullConnection> | null = null;

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    sharedConnection ??= createBullConnection();
    q = new Queue(name, { connection: sharedConnection, defaultJobOptions: jobOptions(name) });
    queues.set(name, q);
  }
  return q;
}

const bullTransport: Transport = async (queue, payload, opts) => {
  await getQueue(queue).add(queue, payload, {
    jobId: opts.jobId ? opts.jobId.replace(/:/g, "_") : undefined,
    delay: opts.delayMs,
  });
};

let transport: Transport = bullTransport;

/** Validate and enqueue a job. Throws on an invalid payload (programming error). */
export async function enqueue<Q extends QueueName>(queue: Q, payload: Payload<Q>, opts: EnqueueOptions = {}): Promise<void> {
  const parsed = PAYLOADS[queue].parse(payload) as Payload<Q>;
  await transport(queue, parsed, opts);
}

/** Captured jobs, for tests that run handlers inline. */
export interface CapturedJob {
  queue: QueueName;
  payload: unknown;
  opts: EnqueueOptions;
}

export function captureJobsForTests(): CapturedJob[] {
  const captured: CapturedJob[] = [];
  transport = async (queue, payload, opts) => {
    if (opts.jobId && captured.some((j) => j.queue === queue && j.opts.jobId === opts.jobId)) return;
    captured.push({ queue, payload, opts });
  };
  return captured;
}

export function restoreQueueTransport(): void {
  transport = bullTransport;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (sharedConnection) {
    await sharedConnection.quit().catch(() => sharedConnection?.disconnect());
    sharedConnection = null;
  }
}
