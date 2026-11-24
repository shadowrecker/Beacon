/** Fans domain events out to subscribers (see src/server/events/dispatcher.ts). */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { dispatchEvent } from "@/server/events/dispatcher";

export const domainEventsWorker = defineWorker({
  queue: QUEUE.DOMAIN_EVENTS,
  concurrency: 8,
  handler: async ({ eventId }, ctx) => {
    await dispatchEvent(eventId, ctx.log);
  },
});
