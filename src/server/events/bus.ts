/**
 * Domain event bus (transactional outbox).
 *
 * `emitEvent` writes a DomainEvent row and enqueues a fan-out job keyed by the
 * event id. The dispatcher (src/workers/domain-events.ts) delivers the event to
 * every subscriber (workflows, webhooks, notifications, team activity, coach) and
 * marks it dispatched. If the enqueue fails, the maintenance sweep re-enqueues
 * undispatched events, so no event is lost. Subscribers must be idempotent.
 */
import { Prisma } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueue, QUEUE } from "../jobs/queues";
import { EVENTS, type EventPayload, type EventType } from "./catalog";

export interface EmitInput<T extends EventType> {
  orgId: string;
  projectId?: string | null;
  type: T;
  payload: EventPayload<T>;
  actorUserId?: string | null;
  /** Depth of workflow-originated causation; 0 for user/system events. */
  causationDepth?: number;
}

export async function emitEvent<T extends EventType>(input: EmitInput<T>, db: DbClient = prisma): Promise<string> {
  const payload = EVENTS[input.type].parse(input.payload);
  const event = await db.domainEvent.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      type: input.type,
      payload: payload as Prisma.InputJsonValue,
      actorUserId: input.actorUserId ?? null,
      causationDepth: input.causationDepth ?? 0,
    },
    select: { id: true },
  });
  try {
    await enqueue(QUEUE.DOMAIN_EVENTS, { eventId: event.id }, { jobId: `evt_${event.id}` });
  } catch (err) {
    // The outbox row is durable; the maintenance sweep will re-dispatch it.
    logger.warn("event enqueue failed; will be re-dispatched", { eventId: event.id, err });
  }
  return event.id;
}

/** Re-enqueue events that were never dispatched (called by maintenance). */
export async function redispatchStaleEvents(olderThanMs = 5 * 60_000): Promise<number> {
  const stale = await prisma.domainEvent.findMany({
    where: { dispatchedAt: null, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
    select: { id: true },
    take: 500,
    orderBy: { createdAt: "asc" },
  });
  for (const e of stale) {
    await enqueue(QUEUE.DOMAIN_EVENTS, { eventId: e.id }, { jobId: `evt_${e.id}` });
  }
  return stale.length;
}
