/**
 * Team activity: one TeamActivity row per meaningful domain event (written by
 * the team-activity subscriber) or team-management action (written directly by
 * the organization router), and the feed that reads them.
 *
 * Rows are idempotent on their source: `metadata.eventId` (or
 * `metadata.sourceKey` for direct writes) is checked before inserting.
 */
import type { DomainEvent, Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { EVENTS, type EventPayload, type EventType } from "../events/catalog";
import { displayName, truncate } from "./format";

export interface ActivityInput {
  orgId: string;
  userId: string;
  projectId?: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, string | number | boolean | null>;
  /** Idempotency key stored in metadata (event id or a direct-write key). */
  sourceKey: string;
}

/** Insert an activity row unless one with the same source key exists. Returns true when written. */
export async function recordActivity(db: DbClient, input: ActivityInput): Promise<boolean> {
  const existing = await db.teamActivity.findFirst({
    where: { orgId: input.orgId, metadata: { path: ["sourceKey"], equals: input.sourceKey } },
    select: { id: true },
  });
  if (existing) return false;
  await db.teamActivity.create({
    data: {
      orgId: input.orgId,
      userId: input.userId,
      projectId: input.projectId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: { ...input.metadata, sourceKey: input.sourceKey } as Prisma.InputJsonValue,
    },
  });
  return true;
}

type Mapper<T extends EventType> = (
  payload: EventPayload<T>
) => { resourceType: string; resourceId: string; metadata: ActivityInput["metadata"] } | null;

/** Events that appear in the activity feed and how each maps to a row. */
export const ACTIVITY_EVENTS: { [T in EventType]?: Mapper<T> } = {
  "document.uploaded": (p) => ({ resourceType: "document", resourceId: p.documentId, metadata: { title: truncate(p.title, 200) } }),
  "synthesis.completed": (p) => ({ resourceType: "synthesis", resourceId: p.synthesisId, metadata: { themeCount: p.themeCount } }),
  "recommendation.created": (p) => ({
    resourceType: "recommendation",
    resourceId: p.recommendationId,
    metadata: { title: truncate(p.title, 200), impact: p.impact },
  }),
  "recommendation.status_changed": (p) => ({
    resourceType: "recommendation",
    resourceId: p.recommendationId,
    metadata: { title: truncate(p.title, 200), from: p.from, to: p.to },
  }),
  "gap.detected": (p) => ({ resourceType: "gap_analysis", resourceId: p.gapAnalysisId, metadata: { gapCount: p.gapCount } }),
  "presentation.ready": (p) => ({ resourceType: "presentation", resourceId: p.presentationId, metadata: { title: truncate(p.title, 200) } }),
  "voice.ready": (p) => ({ resourceType: "voice_recording", resourceId: p.recordingId, metadata: {} }),
  "comment.created": (p) => ({
    resourceType: "comment",
    resourceId: p.commentId,
    metadata: { targetType: p.targetType, targetId: p.targetId },
  }),
  "outcome.updated": (p) => ({ resourceType: "outcome", resourceId: p.outcomeId, metadata: { status: p.status } }),
  "integration.synced": (p) => ({
    resourceType: "integration",
    resourceId: p.integrationId,
    metadata: { provider: p.provider, records: p.records },
  }),
  "member.joined": (p) => ({ resourceType: "member", resourceId: p.userId, metadata: { role: p.role } }),
  "member.removed": (p) => ({ resourceType: "member", resourceId: p.userId, metadata: { removedUserId: p.userId } }),
};

export function isActivityEvent(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(ACTIVITY_EVENTS, type);
}

/** Who did it: the event's actor, or the joining user for member.joined. */
async function resolveActor(db: DbClient, event: DomainEvent, payload: Record<string, unknown>): Promise<string | null> {
  let actor = event.actorUserId;
  if (!actor && event.type === "member.joined") actor = String(payload.userId);
  if (!actor && event.type === "synthesis.completed") {
    const s = await db.synthesis.findUnique({ where: { id: String(payload.synthesisId) }, select: { createdById: true } });
    actor = s?.createdById ?? null;
  }
  if (!actor) return null;
  const exists = await db.user.findUnique({ where: { id: actor }, select: { id: true } });
  return exists ? actor : null;
}

/** Write the activity row for one domain event. Returns false when skipped. */
export async function recordEventActivity(db: DbClient, event: DomainEvent): Promise<boolean> {
  if (!isActivityEvent(event.type)) return false;
  const schema = EVENTS[event.type];
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success) return false;
  const mapper = ACTIVITY_EVENTS[event.type] as Mapper<EventType>;
  const mapped = mapper(parsed.data as never);
  if (!mapped) return false;
  const actor = await resolveActor(db, event, parsed.data as Record<string, unknown>);
  // System-originated events (scheduled syncs etc.) have no person to attribute.
  if (!actor) return false;
  return recordActivity(db, {
    orgId: event.orgId,
    userId: actor,
    projectId: event.projectId,
    action: event.type,
    resourceType: mapped.resourceType,
    resourceId: mapped.resourceId,
    metadata: { ...mapped.metadata, eventId: event.id },
    sourceKey: `event:${event.id}`,
  });
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

const PROVIDER_LABEL = (p: string | null) => (p ? p.charAt(0) + p.slice(1).toLowerCase().replace(/_/g, " ") : "An integration");

/** Human summary, phrased to follow the actor's name ("Jane <summary>"). */
export function describeActivity(
  action: string,
  meta: Record<string, unknown>,
  names: { subject?: string | null; selfAction?: boolean } = {}
): string {
  const n = (key: string) => Number(meta[key] ?? 0);
  switch (action) {
    case "document.uploaded":
      return `added the document "${str(meta, "title") ?? "Untitled"}"`;
    case "synthesis.completed":
      return `ran a synthesis that found ${n("themeCount")} ${n("themeCount") === 1 ? "theme" : "themes"}`;
    case "recommendation.created":
      return `generated the recommendation "${str(meta, "title") ?? "Untitled"}"`;
    case "recommendation.status_changed":
      return `moved "${str(meta, "title") ?? "a recommendation"}" from ${(str(meta, "from") ?? "").toLowerCase()} to ${(str(meta, "to") ?? "").toLowerCase()}`;
    case "gap.detected":
      return `ran a roadmap gap analysis that found ${n("gapCount")} ${n("gapCount") === 1 ? "gap" : "gaps"}`;
    case "presentation.ready":
      return `created the presentation "${str(meta, "title") ?? "Untitled"}"`;
    case "voice.ready":
      return "added a voice recording";
    case "comment.created":
      return `commented on a ${(str(meta, "targetType") ?? "item").toLowerCase()}`;
    case "outcome.updated":
      return `updated an outcome to ${(str(meta, "status") ?? "").toLowerCase().replace(/_/g, " ")}`;
    case "integration.synced":
      return `synced ${n("records")} ${n("records") === 1 ? "record" : "records"} from ${PROVIDER_LABEL(str(meta, "provider"))}`;
    case "member.joined":
      return `joined the organization as ${(str(meta, "role") ?? "member").toLowerCase()}`;
    case "member.removed":
      return names.selfAction ? "left the organization" : `removed ${names.subject ?? "a member"} from the organization`;
    case "member.role_changed":
      return `changed ${names.subject ?? "a member"}'s role from ${(str(meta, "from") ?? "").toLowerCase()} to ${(str(meta, "to") ?? "").toLowerCase()}`;
    case "org.ownership_transferred":
      return `transferred ownership to ${names.subject ?? "another member"}`;
    case "org.renamed":
      return `renamed the organization to "${str(meta, "name") ?? ""}"`;
    default:
      return action.replace(/[._]/g, " ");
  }
}

function activityHref(row: { action: string; resourceType: string; resourceId: string; projectId: string | null; metadata: Record<string, unknown> }): string | null {
  const p = row.projectId;
  switch (row.resourceType) {
    case "document":
      return p ? `/projects/${p}/documents` : null;
    case "synthesis":
      return p ? `/projects/${p}/synthesis` : null;
    case "recommendation":
    case "outcome":
      return p ? `/projects/${p}/${row.resourceType === "outcome" ? "outcomes" : "recommendations"}` : null;
    case "gap_analysis":
      return p ? `/projects/${p}/roadmap` : null;
    case "presentation":
      return `/presentations/${row.resourceId}`;
    case "voice_recording":
      return "/voice";
    case "integration":
      return "/integrations";
    case "comment": {
      const t = str(row.metadata, "targetType");
      if (!p || !t) return null;
      const map: Record<string, string> = {
        THEME: "synthesis",
        SYNTHESIS: "synthesis",
        RECOMMENDATION: "recommendations",
        DOCUMENT: "documents",
        DECISION: "decisions",
      };
      return map[t] ? `/projects/${p}/${map[t]}` : `/projects/${p}`;
    }
    default:
      return null;
  }
}

export interface FeedFilter {
  orgId: string;
  projectId?: string;
  userId?: string;
  limit: number;
  cursor?: string | null;
}

export async function getActivityFeed(db: DbClient, f: FeedFilter) {
  const rows = await db.teamActivity.findMany({
    where: { orgId: f.orgId, ...(f.projectId ? { projectId: f.projectId } : {}), ...(f.userId ? { userId: f.userId } : {}) },
    select: {
      id: true,
      action: true,
      resourceType: true,
      resourceId: true,
      projectId: true,
      metadata: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > f.limit;
  const page = hasMore ? rows.slice(0, f.limit) : rows;

  const projectIds = [...new Set(page.map((r) => r.projectId).filter((p): p is string => !!p))];
  const subjectIds = [
    ...new Set(
      page
        .map((r) => str((r.metadata ?? {}) as Record<string, unknown>, "subjectUserId") ?? str((r.metadata ?? {}) as Record<string, unknown>, "removedUserId"))
        .filter((u): u is string => !!u)
    ),
  ];
  const [projects, subjects] = await Promise.all([
    projectIds.length
      ? db.project.findMany({ where: { id: { in: projectIds }, orgId: f.orgId }, select: { id: true, name: true } })
      : [],
    subjectIds.length ? db.user.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true, email: true } }) : [],
  ]);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const subjectName = new Map(subjects.map((u) => [u.id, displayName(u)]));

  return {
    items: page.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const subjectId = str(meta, "subjectUserId") ?? str(meta, "removedUserId");
      const projectExists = r.projectId ? projectName.has(r.projectId) : false;
      return {
        id: r.id,
        action: r.action,
        createdAt: r.createdAt,
        actor: { id: r.user.id, name: displayName(r.user), avatarUrl: r.user.avatarUrl },
        summary: describeActivity(r.action, meta, {
          subject: subjectId ? (subjectName.get(subjectId) ?? null) : null,
          selfAction: !!subjectId && subjectId === r.user.id,
        }),
        project: r.projectId && projectExists ? { id: r.projectId, name: projectName.get(r.projectId) as string } : null,
        href: r.projectId && !projectExists ? null : activityHref({ ...r, metadata: meta }),
      };
    }),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
