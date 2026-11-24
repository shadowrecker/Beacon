/**
 * Domain event subscriber: in-app notifications (and, per preference, email).
 *
 * - comment.created      -> mentioned members (COMMENT_MENTION) and the author
 *                           of the comment being replied to (COMMENT_REPLY)
 * - synthesis.completed  -> the person who ran it (SYNTHESIS_COMPLETE)
 * - recommendation.created -> the person who generated it (RECOMMENDATION_GENERATED)
 * - integration.failed   -> the org's owners and admins (INTEGRATION_SYNC)
 * - member.joined        -> the org's owners (SYSTEM)
 *
 * Recipients are always re-checked against current org membership. Idempotent:
 * `notify()` skips a (user, resource, title) it already created and the email
 * job id is derived from the event id.
 */
import type { DomainEvent } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { notify } from "../../notifications/notify";
import { EVENTS, type EventPayload, type EventType } from "../catalog";
import type { Subscriber } from "../types";
import { commentTargetPath, RESOURCE, TARGET_LABELS } from "../../collaboration/links";
import { findCommentTarget } from "../../collaboration/targets";
import { mentionsToPlainText, tokenUserIds } from "../../collaboration/mentions";
import { displayName, truncate } from "../../team/format";

const HANDLED: ReadonlySet<string> = new Set<EventType>([
  "comment.created",
  "synthesis.completed",
  "recommendation.created",
  "integration.failed",
  "member.joined",
]);

/** Keep only users who are currently joined members of the org. */
async function joinedMembers(orgId: string, userIds: string[]): Promise<string[]> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = await prisma.orgMember.findMany({
    where: { orgId, userId: { in: ids }, joinedAt: { not: null } },
    select: { userId: true },
  });
  const ok = new Set(rows.map((r) => r.userId));
  return ids.filter((id) => ok.has(id));
}

async function membersWithRoles(orgId: string, roles: Array<"OWNER" | "ADMIN">): Promise<string[]> {
  const rows = await prisma.orgMember.findMany({
    where: { orgId, role: { in: roles }, joinedAt: { not: null } },
    select: { userId: true },
    take: 500,
  });
  return rows.map((r) => r.userId);
}

const PROVIDER_NAMES: Record<string, string> = {
  JIRA: "Jira",
  LINEAR: "Linear",
  ZENDESK: "Zendesk",
  INTERCOM: "Intercom",
  GONG: "Gong",
  SLACK: "Slack",
  HUBSPOT: "HubSpot",
  SALESFORCE: "Salesforce",
  GITHUB: "GitHub",
  NOTION: "Notion",
};
function providerName(p: string): string {
  return PROVIDER_NAMES[p.toUpperCase()] ?? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase().replace(/_/g, " ");
}

async function onCommentCreated(event: DomainEvent, p: EventPayload<"comment.created">, log: Logger): Promise<void> {
  const comment = await prisma.comment.findUnique({
    where: { id: p.commentId },
    select: {
      id: true,
      userId: true,
      content: true,
      targetType: true,
      targetId: true,
      projectId: true,
      user: { select: { name: true, email: true } },
      project: { select: { name: true, orgId: true } },
      parent: { select: { userId: true } },
    },
  });
  if (!comment) {
    log.info("comment no longer exists; nothing to notify", { commentId: p.commentId });
    return;
  }
  const orgId = comment.project.orgId;
  const author = displayName(comment.user);
  const target = await findCommentTarget(prisma, comment.projectId, comment.targetType, comment.targetId);
  const where = `On the ${TARGET_LABELS[comment.targetType]} "${target?.label ?? "item"}" in ${comment.project.name}.`;

  // Names for rendering mention tokens as plain text.
  const tokenIds = tokenUserIds(comment.content);
  const tokenUsers = tokenIds.length
    ? await prisma.user.findMany({ where: { id: { in: tokenIds } }, select: { id: true, name: true, email: true } })
    : [];
  const names = new Map(tokenUsers.map((u) => [u.id, displayName(u)]));
  const excerpt = truncate(mentionsToPlainText(comment.content, names), 280);
  const href = commentTargetPath(comment.projectId, comment.targetType);

  const mentioned = (await joinedMembers(orgId, p.mentionedUserIds)).filter((u) => u !== comment.userId);
  if (mentioned.length > 0) {
    await notify({
      userIds: mentioned,
      type: "COMMENT_MENTION",
      title: `${author} mentioned you`,
      message: `${excerpt}\n\n${where}`,
      resourceType: RESOURCE.COMMENT,
      resourceId: comment.id,
      href,
      dedupeKey: `${event.id}:mention`,
    });
  }

  const parentAuthor = comment.parent?.userId;
  if (parentAuthor && parentAuthor !== comment.userId && !mentioned.includes(parentAuthor)) {
    const [recipient] = await joinedMembers(orgId, [parentAuthor]);
    if (recipient) {
      await notify({
        userIds: [recipient],
        type: "COMMENT_REPLY",
        title: `${author} replied to your comment`,
        message: `${excerpt}\n\n${where}`,
        resourceType: RESOURCE.COMMENT,
        resourceId: comment.id,
        href,
        dedupeKey: `${event.id}:reply`,
      });
    }
  }
}

async function onSynthesisCompleted(event: DomainEvent, p: EventPayload<"synthesis.completed">): Promise<void> {
  const synthesis = await prisma.synthesis.findUnique({
    where: { id: p.synthesisId },
    select: { id: true, projectId: true, createdById: true, project: { select: { name: true, orgId: true } } },
  });
  if (!synthesis) return;
  const actor = event.actorUserId ?? synthesis.createdById;
  if (!actor) return;
  const [recipient] = await joinedMembers(synthesis.project.orgId, [actor]);
  if (!recipient) return;
  await notify({
    userIds: [recipient],
    type: "SYNTHESIS_COMPLETE",
    title: "Synthesis complete",
    message: `Your synthesis in ${synthesis.project.name} finished and found ${p.themeCount} ${p.themeCount === 1 ? "theme" : "themes"}.`,
    resourceType: RESOURCE.SYNTHESIS,
    resourceId: synthesis.id,
    href: `/projects/${synthesis.projectId}/synthesis`,
    dedupeKey: `${event.id}:synthesis`,
  });
}

async function onRecommendationCreated(event: DomainEvent, p: EventPayload<"recommendation.created">): Promise<void> {
  const rec = await prisma.recommendation.findUnique({
    where: { id: p.recommendationId },
    select: { id: true, projectId: true, runId: true, project: { select: { name: true, orgId: true } } },
  });
  if (!rec) return;
  let actor = event.actorUserId;
  if (!actor && rec.runId) {
    const run = await prisma.jobRun.findFirst({ where: { id: rec.runId, projectId: rec.projectId }, select: { createdById: true } });
    actor = run?.createdById ?? null;
  }
  if (!actor) return;
  const [recipient] = await joinedMembers(rec.project.orgId, [actor]);
  if (!recipient) return;
  await notify({
    userIds: [recipient],
    type: "RECOMMENDATION_GENERATED",
    title: `New recommendation: ${truncate(p.title, 120)}`,
    message: `${p.impact.charAt(0)}${p.impact.slice(1).toLowerCase()} impact, ${Math.round(p.confidence * 100)}% confidence, in ${rec.project.name}.`,
    resourceType: RESOURCE.RECOMMENDATION,
    resourceId: rec.id,
    href: `/projects/${rec.projectId}/recommendations`,
    dedupeKey: `${event.id}:recommendation`,
  });
}

async function onIntegrationFailed(event: DomainEvent, p: EventPayload<"integration.failed">): Promise<void> {
  const admins = await membersWithRoles(event.orgId, ["OWNER", "ADMIN"]);
  if (admins.length === 0) return;
  await notify({
    userIds: admins,
    type: "INTEGRATION_SYNC",
    title: `${providerName(p.provider)} sync failed`,
    message: `${truncate(p.error, 400)}\n\nCheck the connection in Integrations.`,
    resourceType: RESOURCE.INTEGRATION,
    resourceId: p.integrationId,
    href: "/integrations",
    dedupeKey: `${event.id}:integration`,
  });
}

async function onMemberJoined(event: DomainEvent, p: EventPayload<"member.joined">): Promise<void> {
  const member = await prisma.orgMember.findUnique({
    where: { orgId_userId: { orgId: event.orgId, userId: p.userId } },
    select: { id: true, joinedAt: true, user: { select: { name: true, email: true } }, organization: { select: { name: true } } },
  });
  if (!member?.joinedAt) return;
  const owners = (await membersWithRoles(event.orgId, ["OWNER"])).filter((u) => u !== p.userId);
  if (owners.length === 0) return;
  const role = p.role.toLowerCase();
  await notify({
    userIds: owners,
    type: "SYSTEM",
    title: `${displayName(member.user)} joined ${member.organization.name}`,
    message: `${displayName(member.user)} accepted an invitation and joined as ${role === "admin" || role === "owner" ? "an" : "a"} ${role}.`,
    resourceType: RESOURCE.ORG_MEMBER,
    resourceId: member.id,
    href: `/team?org=${event.orgId}`,
    dedupeKey: `${event.id}:member`,
  });
}

export const notificationsSubscriber: Subscriber = {
  name: "notifications",
  handles: (type) => HANDLED.has(type),
  handle: async (event, log) => {
    const type = event.type as EventType;
    const parsed = EVENTS[type]?.safeParse(event.payload);
    if (!parsed?.success) {
      // A malformed payload won't improve on retry.
      log.warn("skipping event with invalid payload", { eventId: event.id, type: event.type });
      return;
    }
    switch (type) {
      case "comment.created":
        return onCommentCreated(event, parsed.data as EventPayload<"comment.created">, log);
      case "synthesis.completed":
        return onSynthesisCompleted(event, parsed.data as EventPayload<"synthesis.completed">);
      case "recommendation.created":
        return onRecommendationCreated(event, parsed.data as EventPayload<"recommendation.created">);
      case "integration.failed":
        return onIntegrationFailed(event, parsed.data as EventPayload<"integration.failed">);
      case "member.joined":
        return onMemberJoined(event, parsed.data as EventPayload<"member.joined">);
      default:
        return;
    }
  },
};
