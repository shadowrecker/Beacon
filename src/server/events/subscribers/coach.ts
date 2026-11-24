/**
 * Domain event subscriber: AI coach. Records lightweight activity signals for
 * project events and schedules an asynchronous coaching run (at most one per
 * project per interval). Insight generation happens in the coaching worker,
 * never inline. Idempotent: activity is recorded once per event ID, and the
 * run ID is deterministic per project and time bucket.
 */
import { OBSERVED_EVENTS, recordActivity } from "../../ai/coach/activity";
import { scheduleAutoCoaching } from "../../ai/coach/schedule";
import type { Subscriber } from "../types";

const OBSERVED: ReadonlySet<string> = new Set(OBSERVED_EVENTS);

export const coachSubscriber: Subscriber = {
  name: "coach",
  handles: (type) => OBSERVED.has(type),
  handle: async (event, log) => {
    if (!event.projectId) return;
    await recordActivity({ eventId: event.id, projectId: event.projectId, type: event.type, actorUserId: event.actorUserId, at: event.createdAt });
    const runId = await scheduleAutoCoaching({ orgId: event.orgId, projectId: event.projectId, trigger: "event", eventType: event.type });
    if (runId) log.info("coaching scheduled from activity", { projectId: event.projectId, runId, type: event.type });
  },
};
