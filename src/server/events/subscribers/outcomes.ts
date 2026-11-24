/**
 * Domain event subscriber: outcomes.
 *
 * When a recommendation's status changes to IMPLEMENTED, start tracking its
 * outcome (status SHIPPED, shippedAt now). Idempotent per recommendation, so
 * redelivered or concurrent events never create a second tracking row.
 */
import { EVENTS } from "../catalog";
import type { Subscriber } from "../types";
import { startTrackingForImplemented } from "@/server/ai/outcomes/tracker";

export const outcomesSubscriber: Subscriber = {
  name: "outcomes",
  handles: (type) => type === "recommendation.status_changed",
  handle: async (event, log) => {
    const parsed = EVENTS["recommendation.status_changed"].safeParse(event.payload);
    if (!parsed.success) {
      log.warn("ignoring malformed recommendation.status_changed payload", { eventId: event.id });
      return;
    }
    if (parsed.data.to !== "IMPLEMENTED") return;
    const result = await startTrackingForImplemented({
      recommendationId: parsed.data.recommendationId,
      orgId: event.orgId,
      actorUserId: event.actorUserId,
      causationDepth: event.causationDepth,
    });
    if (result?.created) log.info("outcome tracking started", { recommendationId: parsed.data.recommendationId, outcomeId: result.outcomeId });
  },
};
