/**
 * Domain event subscriber: webhooks.
 *
 * For each public webhook event (WEBHOOK_EVENTS), creates one WebhookDelivery
 * per active webhook of the event's org subscribed to that event, and enqueues
 * QUEUE.WEBHOOKS. Idempotent: the event id is stored in the delivery payload and
 * checked before creating, and job IDs are deterministic per delivery.
 */
import { WEBHOOK_EVENTS } from "../catalog";
import { fanOutEvent } from "../../api/webhook-dispatcher";
import type { Subscriber } from "../types";

const SUBSCRIBABLE = new Set<string>(WEBHOOK_EVENTS);

export const webhooksSubscriber: Subscriber = {
  name: "webhooks",
  handles: (type) => SUBSCRIBABLE.has(type),
  async handle(event, log) {
    await fanOutEvent(event, log);
  },
};
