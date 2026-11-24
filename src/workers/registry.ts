/**
 * Every queue has exactly one worker definition, registered here. The queue
 * contract test asserts this registry covers every queue in QUEUE.
 */
import type { QueueName } from "@/server/jobs/queues";
import type { WorkerDefinition } from "@/server/jobs/worker";
import { documentWorker } from "./document-worker";
import { synthesisWorker } from "./synthesis-worker";
import { recommendationWorker } from "./recommendation-worker";
import { integrationWorker } from "./integration-worker";
import { competitiveWorker } from "./competitive-worker";
import { gapAnalysisWorker } from "./gap-analysis-worker";
import { correlationWorker } from "./correlation-worker";
import { presentationWorker } from "./presentation-worker";
import { sentimentWorker } from "./sentiment-worker";
import { knowledgeWorker } from "./knowledge-worker";
import { voiceWorker } from "./voice-worker";
import { coachingWorker } from "./coaching-worker";
import { handoffWorker } from "./handoff-worker";
import { workflowWorker } from "./workflow-worker";
import { domainEventsWorker } from "./domain-events-worker";
import { webhookWorker } from "./webhook-worker";
import { emailWorker } from "./email-worker";
import { importWorker } from "./import-worker";
import { maintenanceWorker } from "./maintenance-worker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WORKERS: Array<WorkerDefinition<any>> = [
  documentWorker,
  synthesisWorker,
  recommendationWorker,
  integrationWorker,
  competitiveWorker,
  gapAnalysisWorker,
  correlationWorker,
  presentationWorker,
  sentimentWorker,
  knowledgeWorker,
  voiceWorker,
  coachingWorker,
  handoffWorker,
  workflowWorker,
  domainEventsWorker,
  webhookWorker,
  emailWorker,
  importWorker,
  maintenanceWorker,
];

export function workerFor(queue: QueueName) {
  return WORKERS.find((w) => w.queue === queue);
}
