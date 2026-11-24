import type { DomainEvent } from "@prisma/client";
import type { Logger } from "@/lib/logger";

/**
 * A subscriber to domain events. `handle` must be idempotent: the dispatcher
 * records per-subscriber completion and will not re-run a subscriber that
 * already succeeded for an event, but a crash mid-handle can still re-run it.
 */
export interface Subscriber {
  name: string;
  handles(type: string): boolean;
  handle(event: DomainEvent, log: Logger): Promise<void>;
}
