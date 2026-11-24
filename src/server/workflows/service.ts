/**
 * Workflow definition validation shared by create, update and template install.
 *
 * Beyond the per-action zod schemas this enforces the cross-field rules:
 * - self-triggering trigger/action pairs are rejected (loop guard),
 * - every foreign ID in params (recommendation, roadmap, user) must belong to the
 *   workflow's project or org,
 * - recommendation actions need a recommendation source (the trigger event's
 *   payload or an explicit, project-scoped recommendationId).
 */
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { EVENTS } from "../events/catalog";
import {
  actionsSchema,
  normalizeTriggerEvent,
  RECOMMENDATION_ACTIONS,
  ROLE_GROUPS,
  selfTriggerProblem,
  triggerSchema,
  TRIGGER_EVENTS,
  type TriggerEvent,
  type WorkflowAction,
  type WorkflowCondition,
} from "./definitions";

export interface NormalizedDefinition {
  trigger: { event: TriggerEvent; conditions: WorkflowCondition[] };
  actions: WorkflowAction[];
}

function bad(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

function eventCarriesRecommendation(event: TriggerEvent): boolean {
  const shape = (EVENTS[event] as unknown as { shape: Record<string, unknown> }).shape;
  return Object.prototype.hasOwnProperty.call(shape, "recommendationId");
}

function zodMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }, prefix: string): string {
  const issue = error.issues[0];
  const where = issue?.path?.length ? ` (${issue.path.map(String).join(".")})` : "";
  return `${prefix}${where}: ${issue?.message ?? "invalid"}`;
}

export async function validateDefinition(
  db: DbClient,
  scope: { projectId: string; orgId: string },
  input: { trigger: unknown; actions: unknown }
): Promise<NormalizedDefinition> {
  const trigger = triggerSchema.safeParse(input.trigger);
  if (!trigger.success) bad(zodMessage(trigger.error, "Invalid trigger"));
  const actions = actionsSchema.safeParse(input.actions);
  if (!actions.success) bad(zodMessage(actions.error, "Invalid action"));

  const event = normalizeTriggerEvent(trigger.data.event);
  if (!event) bad("Choose a supported trigger event");
  const loop = selfTriggerProblem(event, actions.data);
  if (loop) bad(loop);

  const userIds = new Set<string>();
  const roadmapIds = new Set<string>();
  const recommendationIds = new Set<string>();
  const roleGroups = new Set<string>(ROLE_GROUPS);

  for (const [i, action] of actions.data.entries()) {
    const n = i + 1;
    switch (action.type) {
      case "ASSIGN_USER":
        userIds.add(action.params.userId);
        break;
      case "NOTIFY_EMAIL":
        action.params.recipients.filter((r) => !roleGroups.has(r)).forEach((r) => userIds.add(r));
        break;
      case "ADD_TO_ROADMAP":
        if (action.params.roadmapId) roadmapIds.add(action.params.roadmapId);
        break;
      default:
        break;
    }
    if (RECOMMENDATION_ACTIONS.has(action.type)) {
      const recId = (action.params as { recommendationId?: string }).recommendationId;
      if (recId) recommendationIds.add(recId);
      else if (!eventCarriesRecommendation(event)) {
        bad(`Action ${n} needs a recommendation: the "${TRIGGER_EVENTS[event].label}" event has none, so choose one`);
      }
    }
  }

  if (userIds.size) {
    const members = await db.orgMember.findMany({
      where: { orgId: scope.orgId, userId: { in: [...userIds] }, joinedAt: { not: null } },
      select: { userId: true },
    });
    if (members.length !== userIds.size) bad("Recipients and assignees must be members of this workspace");
  }
  if (roadmapIds.size) {
    const count = await db.roadmap.count({ where: { id: { in: [...roadmapIds] }, projectId: scope.projectId } });
    if (count !== roadmapIds.size) bad("Roadmap not found in this project");
  }
  if (recommendationIds.size) {
    const count = await db.recommendation.count({ where: { id: { in: [...recommendationIds] }, projectId: scope.projectId } });
    if (count !== recommendationIds.size) bad("Recommendation not found in this project");
  }

  return { trigger: { event, conditions: trigger.data.conditions }, actions: actions.data };
}

export function toJson(def: NormalizedDefinition): { trigger: Prisma.InputJsonValue; actions: Prisma.InputJsonValue } {
  return {
    trigger: def.trigger as unknown as Prisma.InputJsonValue,
    actions: def.actions as unknown as Prisma.InputJsonValue,
  };
}
