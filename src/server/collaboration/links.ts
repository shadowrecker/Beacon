/**
 * Where a notification or activity item links to. Notifications store only a
 * (resourceType, resourceId) pair; links are resolved when read so they always
 * reflect the current location of the resource.
 */
import type { CommentTargetType } from "@prisma/client";
import type { DbClient } from "@/lib/db";

export const RESOURCE = {
  COMMENT: "comment",
  SYNTHESIS: "synthesis",
  RECOMMENDATION: "recommendation",
  DOCUMENT: "document",
  INTEGRATION: "integration",
  ORG_MEMBER: "org_member",
  ORG_INVITE: "org_invite",
  ORGANIZATION: "organization",
  PRESENTATION: "presentation",
} as const;

export function commentTargetPath(projectId: string, targetType: CommentTargetType): string {
  switch (targetType) {
    case "THEME":
    case "SYNTHESIS":
      return `/projects/${projectId}/synthesis`;
    case "RECOMMENDATION":
      return `/projects/${projectId}/recommendations`;
    case "DOCUMENT":
      return `/projects/${projectId}/documents`;
    case "DECISION":
      return `/projects/${projectId}/decisions`;
  }
}

export const TARGET_LABELS: Record<CommentTargetType, string> = {
  THEME: "theme",
  RECOMMENDATION: "recommendation",
  SYNTHESIS: "synthesis",
  DOCUMENT: "document",
  DECISION: "decision",
};

export interface ResourceRef {
  resourceType: string | null;
  resourceId: string | null;
}

const key = (t: string, id: string) => `${t}:${id}`;

/** Resolve links for a batch of resources (one query per resource type). */
export async function resolveResourceLinks(db: DbClient, refs: ResourceRef[]): Promise<Map<string, string>> {
  const ids = (type: string) => [
    ...new Set(refs.filter((r) => r.resourceType === type && r.resourceId).map((r) => r.resourceId as string)),
  ];
  const out = new Map<string, string>();

  const commentIds = ids(RESOURCE.COMMENT);
  const synthesisIds = ids(RESOURCE.SYNTHESIS);
  const recommendationIds = ids(RESOURCE.RECOMMENDATION);
  const documentIds = ids(RESOURCE.DOCUMENT);
  const presentationIds = ids(RESOURCE.PRESENTATION);
  const memberIds = ids(RESOURCE.ORG_MEMBER);

  const [comments, syntheses, recommendations, documents, presentations, members] = await Promise.all([
    commentIds.length
      ? db.comment.findMany({ where: { id: { in: commentIds } }, select: { id: true, projectId: true, targetType: true } })
      : [],
    synthesisIds.length ? db.synthesis.findMany({ where: { id: { in: synthesisIds } }, select: { id: true, projectId: true } }) : [],
    recommendationIds.length
      ? db.recommendation.findMany({ where: { id: { in: recommendationIds } }, select: { id: true, projectId: true } })
      : [],
    documentIds.length ? db.document.findMany({ where: { id: { in: documentIds } }, select: { id: true, projectId: true } }) : [],
    presentationIds.length ? db.presentation.findMany({ where: { id: { in: presentationIds } }, select: { id: true } }) : [],
    memberIds.length ? db.orgMember.findMany({ where: { id: { in: memberIds } }, select: { id: true, orgId: true } }) : [],
  ]);

  for (const c of comments) out.set(key(RESOURCE.COMMENT, c.id), commentTargetPath(c.projectId, c.targetType));
  for (const s of syntheses) out.set(key(RESOURCE.SYNTHESIS, s.id), `/projects/${s.projectId}/synthesis`);
  for (const r of recommendations) out.set(key(RESOURCE.RECOMMENDATION, r.id), `/projects/${r.projectId}/recommendations`);
  for (const d of documents) out.set(key(RESOURCE.DOCUMENT, d.id), `/projects/${d.projectId}/documents`);
  for (const p of presentations) out.set(key(RESOURCE.PRESENTATION, p.id), `/presentations/${p.id}`);
  for (const m of members) out.set(key(RESOURCE.ORG_MEMBER, m.id), `/team?org=${m.orgId}`);

  for (const r of refs) {
    if (!r.resourceType || !r.resourceId) continue;
    if (r.resourceType === RESOURCE.INTEGRATION) out.set(key(r.resourceType, r.resourceId), "/integrations");
    if (r.resourceType === RESOURCE.ORG_INVITE) out.set(key(r.resourceType, r.resourceId), "/team#invitations");
    if (r.resourceType === RESOURCE.ORGANIZATION) out.set(key(r.resourceType, r.resourceId), `/team?org=${r.resourceId}`);
  }
  return out;
}

export function linkFor(links: Map<string, string>, ref: ResourceRef): string | null {
  if (!ref.resourceType || !ref.resourceId) return null;
  return links.get(key(ref.resourceType, ref.resourceId)) ?? null;
}
