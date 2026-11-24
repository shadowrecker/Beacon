/**
 * Account lifecycle: GDPR export and erasure.
 *
 * Erasure keeps shared work intact: before the user row is deleted (which
 * cascades to everything that references it), resources they created inside
 * organizations that other people still belong to are re-attributed to a
 * remaining owner. Their personal content (comments, queries, decision log
 * entries, notifications, recordings) is erased.
 */
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getStorage, projectPrefix } from "@/lib/storage";
import { deleteUserData } from "../auth/provision";
import { getIdentityProvider } from "./identity";
import { effectivePrefs } from "./preferences";

export const EXPORT_LIMITS = {
  comments: 5_000,
  notifications: 1_000,
  queries: 2_000,
  decisionLogs: 2_000,
  answerChars: 20_000,
} as const;

/** Bounded JSON export of the user's own data. `truncated` lists any section that hit its cap. */
export async function exportUserData(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, avatarUrl: true, notificationPrefs: true, createdAt: true, updatedAt: true },
  });
  if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

  const take = <K extends keyof typeof EXPORT_LIMITS>(k: K) => EXPORT_LIMITS[k] + 1;
  const [memberships, comments, notifications, queries, decisionLogs] = await Promise.all([
    prisma.orgMember.findMany({
      where: { userId },
      select: { role: true, joinedAt: true, invitedAt: true, organization: { select: { id: true, name: true, isPersonal: true } } },
      take: 1_000,
    }),
    prisma.comment.findMany({
      where: { userId },
      select: { id: true, projectId: true, targetType: true, targetId: true, parentId: true, content: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: "desc" },
      take: take("comments"),
    }),
    prisma.notification.findMany({
      where: { userId },
      select: { id: true, type: true, title: true, message: true, isRead: true, resourceType: true, resourceId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: take("notifications"),
    }),
    prisma.query.findMany({
      where: { userId },
      select: { id: true, projectId: true, question: true, answer: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: take("queries"),
    }),
    prisma.decisionLog.findMany({
      where: { userId },
      select: {
        id: true,
        projectId: true,
        recommendationId: true,
        decision: true,
        reasoning: true,
        evidenceLinks: true,
        outcome: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: take("decisionLogs"),
    }),
  ]);

  const truncated: string[] = [];
  const cap = <T>(rows: T[], k: keyof typeof EXPORT_LIMITS): T[] => {
    if (rows.length > EXPORT_LIMITS[k]) {
      truncated.push(k);
      return rows.slice(0, EXPORT_LIMITS[k]);
    }
    return rows;
  };
  let answersTruncated = false;
  const exportedQueries = cap(queries, "queries").map((q) => {
    if (q.answer && q.answer.length > EXPORT_LIMITS.answerChars) {
      answersTruncated = true;
      return { ...q, answer: q.answer.slice(0, EXPORT_LIMITS.answerChars), answerTruncated: true };
    }
    return { ...q, answerTruncated: false };
  });
  if (answersTruncated) truncated.push("queries.answer");

  return {
    format: "beacon.user-export.v1",
    exportedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      notificationPreferences: effectivePrefs(user.notificationPrefs),
    },
    memberships: memberships.map((m) => ({
      organizationId: m.organization.id,
      organizationName: m.organization.name,
      personal: m.organization.isPersonal,
      role: m.role,
      invitedAt: m.invitedAt,
      joinedAt: m.joinedAt,
    })),
    comments: cap(comments, "comments"),
    notifications: cap(notifications, "notifications"),
    queries: exportedQueries,
    decisionLogs: cap(decisionLogs, "decisionLogs"),
    truncated,
    limits: EXPORT_LIMITS,
  };
}

/** Organizations that would be left without an owner if the user disappeared. */
export async function orgsBlockingDeletion(userId: string): Promise<Array<{ id: string; name: string }>> {
  const owned = await prisma.orgMember.findMany({
    where: { userId, role: "OWNER", joinedAt: { not: null } },
    select: { orgId: true, organization: { select: { name: true } } },
  });
  const blocking: Array<{ id: string; name: string }> = [];
  for (const o of owned) {
    const [otherOwners, otherMembers] = await Promise.all([
      prisma.orgMember.count({ where: { orgId: o.orgId, role: "OWNER", joinedAt: { not: null }, NOT: { userId } } }),
      prisma.orgMember.count({ where: { orgId: o.orgId, joinedAt: { not: null }, NOT: { userId } } }),
    ]);
    if (otherMembers > 0 && otherOwners === 0) blocking.push({ id: o.orgId, name: o.organization.name });
  }
  return blocking;
}

/**
 * Re-attribute what the user created in shared orgs to a remaining owner, so the
 * user-row cascade doesn't delete the team's projects, integrations, workflows,
 * competitor profiles or presentations.
 */
export async function reassignSharedResources(userId: string): Promise<void> {
  const memberships = await prisma.orgMember.findMany({ where: { userId }, select: { orgId: true } });
  for (const { orgId } of memberships) {
    const successor = await prisma.orgMember.findFirst({
      where: { orgId, joinedAt: { not: null }, NOT: { userId } },
      orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
      select: { userId: true },
    });
    if (!successor) continue; // sole member: the org is deleted with the user
    const to = successor.userId;
    await prisma.$transaction([
      prisma.project.updateMany({ where: { orgId, userId }, data: { userId: to } }),
      prisma.integration.updateMany({ where: { orgId, userId }, data: { userId: to } }),
      prisma.competitorProfile.updateMany({ where: { orgId, userId }, data: { userId: to } }),
      prisma.workflow.updateMany({ where: { project: { orgId }, createdBy: userId }, data: { createdBy: to } }),
      prisma.presentation.updateMany({ where: { project: { orgId }, userId }, data: { userId: to } }),
    ]);
  }
}

/**
 * Delete the account: re-attribute shared work, delete the sign-in account (a
 * failure here leaves the user's data intact and the request retryable), then
 * erase the user's data and stored objects directly so erasure doesn't depend
 * on the Clerk `user.deleted` webhook (which repeats it idempotently).
 */
export async function deleteAccount(user: { id: string; clerkId: string }): Promise<{ deletedProjects: number }> {
  const blocking = await orgsBlockingDeletion(user.id);
  if (blocking.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `You're the only owner of ${blocking.map((b) => `"${b.name}"`).join(", ")}. Make someone else an owner or delete ${blocking.length === 1 ? "it" : "them"} first.`,
    });
  }

  // Re-attribute shared work first: if anything below fails, the team keeps it.
  await reassignSharedResources(user.id);

  try {
    await getIdentityProvider().deleteUser(user.clerkId);
  } catch (err) {
    logger.error("identity provider deletion failed", { userId: user.id, err });
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "We couldn't delete your account. Please try again." });
  }

  const { deletedProjectIds } = await deleteUserData(user.clerkId);
  const storage = getStorage();
  for (const projectId of deletedProjectIds) {
    await storage.deletePrefix(projectPrefix(projectId)).catch((err) =>
      logger.error("failed to purge project objects", { projectId, err })
    );
  }
  return { deletedProjects: deletedProjectIds.length };
}
