/**
 * Domain event subscriber: workflows.
 *
 * For each triggerable event, finds the enabled workflows of the event's
 * project (or, for org-level events without a project, of every project in the
 * event's org) whose trigger matches, evaluates their conditions safely, and
 * enqueues one run per (workflow, event) with a deterministic job ID. The
 * worker's unique (workflowId, eventId) run row makes redelivery a no-op.
 *
 * Loop guard: events at causationDepth >= MAX_CAUSATION_DEPTH are ignored.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { WORKFLOW_TRIGGER_EVENTS } from "../catalog";
import { enqueue, QUEUE } from "../../jobs/queues";
import { evaluateConditions } from "../../workflows/conditions";
import { MAX_CAUSATION_DEPTH, normalizeTriggerEvent, TRIGGER_EVENTS } from "../../workflows/definitions";
import type { Subscriber } from "../types";

const MAX_WORKFLOWS_PER_EVENT = 500;

export const workflowsSubscriber: Subscriber = {
  name: "workflows",
  handles: (type) => Object.prototype.hasOwnProperty.call(TRIGGER_EVENTS, type),
  async handle(event, log) {
    if (event.causationDepth >= MAX_CAUSATION_DEPTH) {
      log.warn("workflow trigger skipped: causation depth limit reached", { eventId: event.id, depth: event.causationDepth });
      return;
    }
    // Stored triggers may use the legacy enum name for the same event.
    const names = [event.type, ...Object.entries(WORKFLOW_TRIGGER_EVENTS).filter(([, v]) => v === event.type).map(([k]) => k)];
    const where: Prisma.WorkflowWhereInput = {
      enabled: true,
      project: { orgId: event.orgId },
      ...(event.projectId ? { projectId: event.projectId } : {}),
      OR: names.map((n) => ({ trigger: { path: ["event"], equals: n } })),
    };
    const workflows = await prisma.workflow.findMany({
      where,
      select: { id: true, trigger: true },
      orderBy: { createdAt: "asc" },
      take: MAX_WORKFLOWS_PER_EVENT,
    });

    let queued = 0;
    for (const wf of workflows) {
      const trigger = (wf.trigger ?? {}) as { event?: unknown; conditions?: unknown };
      if (normalizeTriggerEvent(trigger.event) !== event.type) continue;
      if (!evaluateConditions(trigger.conditions, event.payload)) continue;
      await enqueue(QUEUE.WORKFLOWS, { workflowId: wf.id, eventId: event.id }, { jobId: `wf_${wf.id}_${event.id}` });
      queued++;
    }
    if (queued) log.info("workflows triggered", { eventId: event.id, type: event.type, queued });
  },
};
