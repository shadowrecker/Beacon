/**
 * Authorization: the one place that decides who may do what.
 *
 * Tenancy is org-based. Every project belongs to an organization; access to a
 * project (and to everything inside it) is granted by membership in that org,
 * with the member's role mapped to permissions below. Resources that are not in
 * the caller's orgs are reported as NOT_FOUND, so IDs cannot be probed.
 */
import { TRPCError } from "@trpc/server";
import type { OrgMemberRole } from "@prisma/client";
import type { DbClient } from "@/lib/db";

export type Permission =
  | "project:read"
  | "project:create"
  | "project:write"
  | "project:delete"
  | "ai:run"
  | "data:export"
  | "org:read"
  | "org:manage"
  | "members:manage"
  | "owners:manage"
  | "integrations:manage"
  | "customAI:manage"
  | "apiKeys:manage"
  | "webhooks:manage"
  | "workflows:manage";

const MEMBER_PERMS: Permission[] = [
  "org:read",
  "project:read",
  "project:create",
  "project:write",
  "ai:run",
  "data:export",
  "workflows:manage",
];

const ADMIN_PERMS: Permission[] = [
  ...MEMBER_PERMS,
  "project:delete",
  "org:manage",
  "members:manage",
  "integrations:manage",
  "customAI:manage",
  "apiKeys:manage",
  "webhooks:manage",
];

export const ROLE_PERMISSIONS: Record<OrgMemberRole, ReadonlySet<Permission>> = {
  OWNER: new Set<Permission>([...ADMIN_PERMS, "owners:manage"]),
  ADMIN: new Set<Permission>(ADMIN_PERMS),
  MEMBER: new Set<Permission>(MEMBER_PERMS),
  VIEWER: new Set<Permission>(["org:read", "project:read"]),
};

export function can(role: OrgMemberRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

const ROLE_RANK: Record<OrgMemberRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
export function roleRank(role: OrgMemberRole): number {
  return ROLE_RANK[role];
}

export interface AccessContext {
  prisma: DbClient;
  user: { id: string } | null;
}

export interface Membership {
  orgId: string;
  role: OrgMemberRole;
}

export function requireUser(ctx: AccessContext): { id: string } {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  return ctx.user;
}

export async function getMembership(db: DbClient, userId: string, orgId: string): Promise<Membership | null> {
  const m = await db.orgMember.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { orgId: true, role: true, joinedAt: true },
  });
  if (!m || !m.joinedAt) return null;
  return { orgId: m.orgId, role: m.role };
}

/** Require membership in `orgId` with `permission`. NOT_FOUND for non-members. */
export async function requireOrgPermission(
  ctx: AccessContext,
  orgId: string,
  permission: Permission
): Promise<Membership> {
  const user = requireUser(ctx);
  const membership = await getMembership(ctx.prisma, user.id, orgId);
  if (!membership) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
  if (!can(membership.role, permission)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to do this" });
  }
  return membership;
}

export interface AccessibleProject {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  role: OrgMemberRole;
}

/**
 * Require access to a project with `permission`. Returns the project with the
 * caller's role. Use the returned `id` for every subsequent query so a foreign
 * resource ID can never be paired with an authorized project.
 */
export async function requireProjectAccess(
  ctx: AccessContext,
  projectId: string,
  permission: Permission
): Promise<AccessibleProject> {
  const user = requireUser(ctx);
  const project = await ctx.prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true, userId: true, name: true },
  });
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  const membership = await getMembership(ctx.prisma, user.id, project.orgId);
  if (!membership) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  if (!can(membership.role, permission)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to do this" });
  }
  return { ...project, role: membership.role };
}

/** Throw NOT_FOUND unless `row` exists (used after a project-scoped lookup). */
export function found<T>(row: T | null | undefined, what: string): T {
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
  return row;
}

/** All org IDs the user is a (joined) member of. */
export async function memberOrgIds(db: DbClient, userId: string): Promise<string[]> {
  const rows = await db.orgMember.findMany({
    where: { userId, joinedAt: { not: null } },
    select: { orgId: true },
  });
  return rows.map((r) => r.orgId);
}
