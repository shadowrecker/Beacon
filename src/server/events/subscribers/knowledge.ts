/**
 * Domain event subscriber: knowledge graph. On `document.ready`, marks the
 * document's knowledge JobRun PENDING and enqueues extraction. Idempotent: the
 * JobRun ID is derived from the document and the job ID from the event, so a
 * redelivered event never enqueues twice, while a document that becomes READY
 * again (re-processed with new content) is re-extracted.
 */
import { prisma } from "@/lib/db";
import { EVENTS } from "../catalog";
import { enqueue, QUEUE } from "../../jobs/queues";
import { knowledgeRunId } from "../../ai/knowledge/pipeline";
import type { Subscriber } from "../types";

export const knowledgeSubscriber: Subscriber = {
  name: "knowledge",
  handles: (type) => type === "document.ready",
  handle: async (event, log) => {
    const { documentId } = EVENTS["document.ready"].parse(event.payload);
    const doc = await prisma.document.findFirst({
      where: { id: documentId, project: { orgId: event.orgId } },
      select: { id: true, projectId: true, status: true },
    });
    if (!doc || doc.status !== "READY") {
      log.info("document not ready or not in org; skipping knowledge extraction", { documentId });
      return;
    }
    const runId = knowledgeRunId(documentId);
    await prisma.jobRun.upsert({
      where: { id: runId },
      create: {
        id: runId,
        kind: "KNOWLEDGE_EXTRACTION",
        orgId: event.orgId,
        projectId: doc.projectId,
        status: "PENDING",
        input: { documentId },
      },
      update: { status: "PENDING", errorMessage: null, completedAt: null },
    });
    await enqueue(QUEUE.KNOWLEDGE, { documentId }, { jobId: `kg_${documentId}_${event.id}` });
  },
};
