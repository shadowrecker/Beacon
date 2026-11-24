/**
 * Worker for QUEUE.WEBHOOKS: delivers one signed webhook POST.
 * Non-2xx responses throw so BullMQ retries (6 attempts, exponential backoff,
 * configured in src/server/jobs/queues.ts). See src/server/api/webhook-dispatcher.ts.
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { deliverWebhook, markDeliveryFailed } from "@/server/api/webhook-dispatcher";

export const webhookWorker = defineWorker({
  queue: QUEUE.WEBHOOKS,
  concurrency: 8,
  handler: (data, ctx) => deliverWebhook(data.deliveryId, ctx),
  onFinalFailure: (data) => markDeliveryFailed(data.deliveryId),
});
