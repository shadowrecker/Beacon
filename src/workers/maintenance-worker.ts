/**
 * Maintenance queue: stuck-job sweep, retention, event re-dispatch, and the
 * feature schedulers (sentiment, competitive monitoring, integration sync, coach).
 * Repeat schedules are registered at worker boot (see MAINTENANCE_SCHEDULES).
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { applyRetention, cleanupAbandonedUploads, sweepStuckJobs } from "@/server/jobs/maintenance";
import { redispatchStaleEvents } from "@/server/events/bus";
import { run as scheduleSentiment } from "@/server/schedules/sentiment";
import { run as scheduleCompetitive } from "@/server/schedules/competitive";
import { run as scheduleIntegrations } from "@/server/schedules/integrations";
import { run as scheduleCoach } from "@/server/schedules/coach";

export const MAINTENANCE_SCHEDULES = [
  { task: "sweep-stuck-jobs", every: "*/10 * * * *" },
  { task: "retention", every: "17 3 * * *" },
  { task: "schedule-sentiment", every: "5 2 * * *" },
  { task: "schedule-competitive", every: "35 */6 * * *" },
  { task: "schedule-integrations", every: "*/30 * * * *" },
  { task: "schedule-coach", every: "45 8 * * 1-5" },
] as const;

export const maintenanceWorker = defineWorker({
  queue: QUEUE.MAINTENANCE,
  concurrency: 1,
  handler: async ({ task }, ctx) => {
    switch (task) {
      case "sweep-stuck-jobs": {
        const swept = await sweepStuckJobs();
        const abandonedUploads = await cleanupAbandonedUploads();
        const redispatched = await redispatchStaleEvents();
        return { swept, abandonedUploads, redispatched };
      }
      case "retention":
        return applyRetention();
      case "schedule-sentiment":
        return { enqueued: await scheduleSentiment() };
      case "schedule-competitive":
        return { enqueued: await scheduleCompetitive() };
      case "schedule-integrations":
        return { enqueued: await scheduleIntegrations() };
      case "schedule-coach":
        return { enqueued: await scheduleCoach() };
      default:
        ctx.log.warn("unknown maintenance task", { task });
        return undefined;
    }
  },
});
