/**
 * Worker for QUEUE.VOICE: transcribes a finalized recording with Deepgram,
 * creates its transcript document and insights (src/server/ai/voice/process.ts).
 */
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker } from "@/server/jobs/worker";
import { markVoiceFailed, runVoiceProcessing } from "@/server/ai/voice/process";

export const voiceWorker = defineWorker({
  queue: QUEUE.VOICE,
  concurrency: 2,
  handler: async (data, ctx) => runVoiceProcessing(data, ctx.log),
  onFinalFailure: async (data, err) => markVoiceFailed(data, err),
});
