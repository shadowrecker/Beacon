/**
 * User provisioning. A Beacon user exists for every Clerk user and always has a
 * personal organization, so every project has an owning org.
 *
 * Called from the Clerk webhook (authoritative) and, as a fallback for the first
 * request after sign-up if the webhook hasn't arrived yet, from the tRPC context.
 * Idempotent and race-safe: concurrent calls converge on one user and one
 * personal org.
 */
import { Prisma } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { slugify } from "@/lib/utils";

export interface ClerkProfile {
  clerkId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

function personalOrgSlug(name: string | null, email: string | null): string {
  const base = slugify(name || email?.split("@")[0] || "workspace").slice(0, 40) || "workspace";
  return `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

async function ensurePersonalOrg(db: DbClient, userId: string, name: string | null, email: string | null): Promise<string> {
  const existing = await db.orgMember.findFirst({
    where: { userId, organization: { isPersonal: true } },
    select: { orgId: true },
  });
  if (existing) return existing.orgId;
  const org = await db.organization.create({
    data: {
      name: name ? `${name}'s workspace` : "Personal workspace",
      slug: personalOrgSlug(name, email),
      isPersonal: true,
      members: { create: { userId, role: "OWNER", joinedAt: new Date() } },
    },
    select: { id: true },
  });
  return org.id;
}

export async function upsertUserFromClerk(profile: ClerkProfile): Promise<{ userId: string; personalOrgId: string }> {
  const run = async () =>
    prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { clerkId: profile.clerkId },
        update: { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl },
        create: {
          clerkId: profile.clerkId,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl,
        },
        select: { id: true },
      });
      const personalOrgId = await ensurePersonalOrg(tx, user.id, profile.name, profile.email);
      return { userId: user.id, personalOrgId };
    });

  try {
    return await run();
  } catch (err) {
    // Two first-requests racing: one wins the unique constraint; retry once.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Another user already holds this email (e.g. re-created Clerk account):
      // clear it on the stale row only when that row is a different Clerk user.
      if (profile.email) {
        await prisma.user.updateMany({
          where: { email: profile.email, NOT: { clerkId: profile.clerkId } },
          data: { email: null },
        });
      }
      return run();
    }
    throw err;
  }
}

/**
 * Delete a user and everything only they own (GDPR erasure). Orgs where they are
 * the sole member are deleted with all their projects; in shared orgs, their
 * membership is removed (ownership is transferred first by the caller's UI rules).
 * Returns the project IDs whose stored objects must be purged.
 */
export async function deleteUserData(clerkId: string): Promise<{ deletedProjectIds: string[] }> {
  const user = await prisma.user.findUnique({ where: { clerkId }, select: { id: true } });
  if (!user) return { deletedProjectIds: [] };

  // Shared work (projects, integrations, competitors, workflows, presentations
  // the user created in team orgs) cascades on the creator. Re-attribute it to a
  // remaining member first, so deleting one person's account (including from the
  // Clerk dashboard, outside Beacon's own deletion flow) never deletes a team's data.
  const { reassignSharedResources } = await import("../team/account");
  await reassignSharedResources(user.id);

  const memberships = await prisma.orgMember.findMany({
    where: { userId: user.id },
    select: { orgId: true, organization: { select: { _count: { select: { members: true } } } } },
  });
  const soleOrgIds = memberships.filter((m) => m.organization._count.members <= 1).map((m) => m.orgId);

  const projects = await prisma.project.findMany({
    where: { OR: [{ orgId: { in: soleOrgIds } }, { userId: user.id, orgId: { in: soleOrgIds } }] },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.organization.deleteMany({ where: { id: { in: soleOrgIds } } }),
    prisma.user.delete({ where: { id: user.id } }),
  ]);
  return { deletedProjectIds: projects.map((p) => p.id) };
}
