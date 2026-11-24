/**
 * Worker for QUEUE.KNOWLEDGE: extracts entities and relations from one READY
 * document into the org's knowledge graph (see src/server/ai/knowledge/pipeline.ts).
 * Tracking row: the document's knowledge JobRun (`kg_<documentId>`), created by
 * the knowledge subscriber and updated here.
 */
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, failureMessage } from "@/server/jobs/worker";
import { knowledgeRunId, processDocumentKnowledge } from "@/server/ai/knowledge/pipeline";

export const knowledgeWorker = defineWorker({
  queue: QUEUE.KNOWLEDGE,
  concurrency: 2,
  handler: async ({ documentId }, ctx) => processDocumentKnowledge(documentId, ctx.log, ctx.updateProgress),
  onFinalFailure: async ({ documentId }, error) => {
    await prisma.jobRun.updateMany({
      where: { id: knowledgeRunId(documentId), status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: failureMessage(error), completedAt: new Date() },
    });
  },
});
