/**
 * Domain event subscriber: team activity feed. Writes one TeamActivity row per
 * person-initiated event (see ACTIVITY_EVENTS), idempotent on the event id.
 */
import { prisma } from "@/lib/db";
import type { Subscriber } from "../types";
import { isActivityEvent, recordEventActivity } from "../../team/activity";

export const teamActivitySubscriber: Subscriber = {
  name: "team-activity",
  handles: (type) => isActivityEvent(type),
  handle: async (event, log) => {
    const written = await recordEventActivity(prisma, event);
    if (!written) log.debug("no activity recorded", { eventId: event.id, type: event.type });
  },
};
