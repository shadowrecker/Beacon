/**
 * Organizations, memberships and invitations.
 *
 * Authorization rules:
 * - `plan` is never writable here (only the server-side admin path changes it).
 * - Only an OWNER may grant, revoke or invite the OWNER role, or remove an OWNER.
 * - Every organization keeps at least one OWNER.
 * - People join only by accepting an invitation sent to an email they verified.
 * - Inviting answers identically whether or not the email has an account.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { router, protectedProcedure, outboundProcedure, rateLimited } from "../trpc";
import { can, found, requireOrgPermission } from "../auth/access";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { randomToken } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getStorage, projectPrefix } from "@/lib/storage";
import { slugify } from "@/lib/utils";
import { prisma, type DbClient } from "@/lib/db";
import { assertCanCreate, PLAN_LIMITS } from "../usage/entitlements";
import { emitEvent } from "../events/bus";
import {
  acceptInvite,
  clearInviteNotifications,
  declineInvite,
  findInvite,
  inviteStatus,
  issueInvite,
  normalizeEmail,
  verifiedEmailsOf,
} from "../team/invites";
import { assertMayChangeRole, assertNotLastOwner, currentRole, lockOrg, revokeMemberApiKeys } from "../team/members";
import { recordActivity } from "../team/activity";
import { displayName, maskEmail } from "../team/format";

const id = z.string().min(1).max(64);
const orgId = z.string().min(1).max(64);
const role = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
const orgName = z.string().trim().min(1, "Name is required").max(80, "Names can be at most 80 characters");
const email = z.string().trim().toLowerCase().max(254).email("Enter a valid email address");
const token = z.string().min(20).max(128).regex(/^[A-Za-z0-9_-]+$/, "Invalid invitation link");
const inviteLookup = z.union([z.object({ token }).strict(), z.object({ inviteId: id }).strict()]);
const page = { limit: z.number().int().min(1).max(100).default(25), cursor: id.nullish() };

/** Invite lookups call the identity provider; keep them bounded per user. */
const INVITE_LOOKUP_RATE = { name: "invite-lookup", limit: 30, windowMs: 60_000, failClosed: false } as const;

/** Most non-personal organizations one person may own (abuse guard). */
const MAX_OWNED_ORGS = 20;

async function uniqueSlug(db: DbClient, name: string): Promise<string> {
  const base = slugify(name).slice(0, 40).replace(/-+$/, "") || "org";
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5)}`;
    const taken = await db.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  return `${base}-${randomToken(8).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

function directKey(kind: string): string {
  return `direct:${kind}:${randomToken(9)}`;
}

export const organizationRouter = router({
  /** Contract (org switcher): joined memberships only, exactly these fields. */
  listMine: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.prisma.orgMember.findMany({
      where: { userId: ctx.user.id, joinedAt: { not: null } },
      select: {
        role: true,
        organization: { select: { id: true, name: true, slug: true, isPersonal: true, plan: true } },
      },
      take: 500,
    });
    return rows
      .map((r) => ({
        id: r.organization.id,
        name: r.organization.name,
        slug: r.organization.slug,
        isPersonal: r.organization.isPersonal,
        role: r.role,
        plan: r.organization.plan,
      }))
      .sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name));
  }),

  create: protectedProcedure
    .use(rateLimited(RATE_LIMITS.write))
    .input(z.object({ name: orgName }).strict())
    .mutation(async ({ ctx, input }) => {
      const owned = await ctx.prisma.orgMember.count({
        where: { userId: ctx.user.id, role: "OWNER", joinedAt: { not: null }, organization: { isPersonal: false } },
      });
      if (owned >= MAX_OWNED_ORGS) {
        throw new TRPCError({ code: "FORBIDDEN", message: `You can own at most ${MAX_OWNED_ORGS} organizations.` });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const org = await ctx.prisma.organization.create({
            data: {
              name: input.name,
              slug: await uniqueSlug(ctx.prisma, input.name),
              members: { create: { userId: ctx.user.id, role: "OWNER", joinedAt: new Date() } },
            },
            select: { id: true, name: true, slug: true, isPersonal: true, plan: true },
          });
          return { ...org, role: "OWNER" as const };
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
          throw err;
        }
      }
      throw new TRPCError({ code: "CONFLICT", message: "Could not create the organization. Please try again." });
    }),

  get: protectedProcedure.input(z.object({ orgId })).query(async ({ ctx, input }) => {
    const membership = await requireOrgPermission(ctx, input.orgId, "org:read");
    const org = found(
      await ctx.prisma.organization.findUnique({
        where: { id: input.orgId },
        select: { id: true, name: true, slug: true, plan: true, isPersonal: true, createdAt: true },
      }),
      "Organization"
    );
    const [me, members, projects, pendingInvites] = await Promise.all([
      ctx.prisma.orgMember.findUnique({ where: { orgId_userId: { orgId: org.id, userId: ctx.user.id } }, select: { id: true } }),
      ctx.prisma.orgMember.count({ where: { orgId: org.id, joinedAt: { not: null } } }),
      ctx.prisma.project.count({ where: { orgId: org.id } }),
      ctx.prisma.orgInvite.count({ where: { orgId: org.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
    ]);
    return {
      ...org,
      role: membership.role,
      memberId: me?.id ?? null,
      counts: { members, projects, pendingInvites },
      limits: { maxMembers: PLAN_LIMITS[org.plan].maxMembers, maxProjects: PLAN_LIMITS[org.plan].maxProjects },
      permissions: {
        manage: can(membership.role, "org:manage"),
        manageMembers: can(membership.role, "members:manage"),
        manageOwners: can(membership.role, "owners:manage"),
      },
    };
  }),

  /** Rename. The plan is deliberately not accepted here. */
  update: protectedProcedure
    .input(z.object({ orgId, name: orgName }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireOrgPermission(ctx, input.orgId, "org:manage");
      const org = await ctx.prisma.organization.update({
        where: { id: input.orgId },
        data: { name: input.name },
        select: { id: true, name: true, slug: true, isPersonal: true, plan: true },
      });
      await recordActivity(ctx.prisma, {
        orgId: org.id,
        userId: ctx.user.id,
        action: "org.renamed",
        resourceType: "organization",
        resourceId: org.id,
        metadata: { name: org.name },
        sourceKey: directKey("rename"),
      });
      return org;
    }),

  listMembers: protectedProcedure
    .input(z.object({ orgId, query: z.string().trim().max(100).optional(), ...page }))
    .query(async ({ ctx, input }) => {
      await requireOrgPermission(ctx, input.orgId, "org:read");
      const q = input.query;
      const rows = await ctx.prisma.orgMember.findMany({
        where: {
          orgId: input.orgId,
          joinedAt: { not: null },
          ...(q
            ? {
                user: {
                  OR: [
                    { name: { contains: q, mode: "insensitive" as const } },
                    { email: { contains: q, mode: "insensitive" as const } },
                  ],
                },
              }
            : {}),
        },
        select: {
          id: true,
          role: true,
          joinedAt: true,
          user: { select: { id: true, name: true, email: true, avatarUrl: true } },
        },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map((m) => ({
        memberId: m.id,
        userId: m.user.id,
        name: displayName(m.user),
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        joinedAt: m.joinedAt as Date,
        isSelf: m.user.id === ctx.user.id,
      }));
      return { items, nextCursor: hasMore ? items[items.length - 1].memberId : null };
    }),

  invite: outboundProcedure
    .input(z.object({ orgId, email, role: role.default("MEMBER") }).strict())
    .mutation(async ({ ctx, input }) => {
      const membership = await requireOrgPermission(ctx, input.orgId, "members:manage");
      const org = found(
        await ctx.prisma.organization.findUnique({ where: { id: input.orgId }, select: { id: true, isPersonal: true } }),
        "Organization"
      );
      if (org.isPersonal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Personal workspaces can't have other members. Create an organization to collaborate.",
        });
      }
      if (input.role === "OWNER" && !can(membership.role, "owners:manage")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can invite another owner" });
      }

      const target = normalizeEmail(input.email);
      const alreadyMember = await ctx.prisma.orgMember.findFirst({
        where: { orgId: org.id, joinedAt: { not: null }, user: { email: target } },
        select: { id: true },
      });
      if (alreadyMember) throw new TRPCError({ code: "CONFLICT", message: "That person is already a member of this organization" });

      const existing = await ctx.prisma.orgInvite.findUnique({
        where: { orgId_email: { orgId: org.id, email: target } },
        select: { role: true, acceptedAt: true, revokedAt: true, expiresAt: true },
      });
      if (existing && existing.role === "OWNER" && !can(membership.role, "owners:manage")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can change an owner invitation" });
      }
      // A still-pending invite is refreshed; anything else takes a new seat.
      if (!existing || inviteStatus(existing) !== "pending") await assertCanCreate(org.id, "members");

      const inviter = { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email };
      const invite = await issueInvite(ctx.prisma, { orgId: org.id, email: target, role: input.role }, inviter);
      return { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
    }),

  listInvites: protectedProcedure.input(z.object({ orgId, ...page })).query(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, input.orgId, "members:manage");
    const rows = await ctx.prisma.orgInvite.findMany({
      where: { orgId: input.orgId, acceptedAt: null, revokedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        expiresAt: true,
        invitedBy: { select: { name: true, email: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > input.limit;
    const now = new Date();
    const items = (hasMore ? rows.slice(0, input.limit) : rows).map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      expired: i.expiresAt <= now,
      invitedBy: displayName(i.invitedBy),
    }));
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }),

  revokeInvite: protectedProcedure.input(z.object({ orgId, inviteId: id })).mutation(async ({ ctx, input }) => {
    const membership = await requireOrgPermission(ctx, input.orgId, "members:manage");
    const invite = found(
      await ctx.prisma.orgInvite.findFirst({
        where: { id: input.inviteId, orgId: input.orgId },
        select: { id: true, role: true, acceptedAt: true },
      }),
      "Invitation"
    );
    if (invite.role === "OWNER" && !can(membership.role, "owners:manage")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can revoke an owner invitation" });
    }
    if (invite.acceptedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation was already accepted" });
    await ctx.prisma.orgInvite.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
    await clearInviteNotifications(ctx.prisma, invite.id);
    return { id: invite.id };
  }),

  /** Email a fresh link (the previous link stops working) and extend the expiry. */
  resendInvite: outboundProcedure.input(z.object({ orgId, inviteId: id })).mutation(async ({ ctx, input }) => {
    const membership = await requireOrgPermission(ctx, input.orgId, "members:manage");
    const invite = found(
      await ctx.prisma.orgInvite.findFirst({
        where: { id: input.inviteId, orgId: input.orgId },
        select: { id: true, email: true, role: true, acceptedAt: true, revokedAt: true, expiresAt: true },
      }),
      "Invitation"
    );
    if (invite.role === "OWNER" && !can(membership.role, "owners:manage")) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can resend an owner invitation" });
    }
    const status = inviteStatus(invite);
    if (status === "accepted" || status === "revoked") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation is no longer pending. Send a new one instead." });
    }
    if (status === "expired") await assertCanCreate(input.orgId, "members");
    const res = await issueInvite(
      ctx.prisma,
      { orgId: input.orgId, email: invite.email, role: invite.role },
      { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email }
    );
    return { id: res.id, expiresAt: res.expiresAt };
  }),

  /** Invitation preview for /invite/[token] (signed-in users). */
  getInvite: protectedProcedure.use(rateLimited(INVITE_LOOKUP_RATE)).input(z.object({ token })).query(async ({ ctx, input }) => {
    const invite = await findInvite(ctx.prisma, { token: input.token });
    if (!invite) return { found: false as const };
    const verified = await verifiedEmailsOf(ctx.user);
    const emailMatches = verified.includes(normalizeEmail(invite.email));
    const member = await ctx.prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: invite.orgId, userId: ctx.user.id } },
      select: { joinedAt: true },
    });
    return {
      found: true as const,
      id: invite.id,
      status: inviteStatus(invite),
      orgId: invite.orgId,
      orgName: invite.organization.name,
      inviterName: displayName(invite.invitedBy),
      role: invite.role,
      expiresAt: invite.expiresAt,
      emailMatches,
      // Show the full address only to its owner.
      invitedEmail: emailMatches ? invite.email : maskEmail(invite.email),
      signedInEmail: ctx.user.email,
      alreadyMember: !!member?.joinedAt,
    };
  }),

  /** Pending invitations addressed to the caller's email (onboarding, team page). */
  myInvites: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user.email) return [];
    const rows = await ctx.prisma.orgInvite.findMany({
      where: { email: normalizeEmail(ctx.user.email), acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        organization: { select: { id: true, name: true } },
        invitedBy: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      orgId: r.organization.id,
      orgName: r.organization.name,
      inviterName: displayName(r.invitedBy),
    }));
  }),

  acceptInvite: protectedProcedure.use(rateLimited(INVITE_LOOKUP_RATE)).input(inviteLookup).mutation(async ({ ctx, input }) => {
    return acceptInvite(input, ctx.user);
  }),

  declineInvite: protectedProcedure.use(rateLimited(INVITE_LOOKUP_RATE)).input(inviteLookup).mutation(async ({ ctx, input }) => {
    return declineInvite(input, ctx.user);
  }),

  updateMemberRole: protectedProcedure
    .input(z.object({ orgId, memberId: id, role }).strict())
    .mutation(async ({ ctx, input }) => {
      await requireOrgPermission(ctx, input.orgId, "members:manage");
      const change = await prisma.$transaction(async (tx) => {
        await lockOrg(tx, input.orgId);
        const actorRole = await currentRole(tx, input.orgId, ctx.user.id);
        const target = found(
          await tx.orgMember.findFirst({
            where: { id: input.memberId, orgId: input.orgId, joinedAt: { not: null } },
            select: { id: true, userId: true, role: true },
          }),
          "Member"
        );
        if (target.role === input.role) return null;
        assertMayChangeRole(actorRole, target.role, input.role);
        if (target.role === "OWNER") await assertNotLastOwner(tx, input.orgId, "OWNER");
        await tx.orgMember.update({ where: { id: target.id }, data: { role: input.role } });
        return { userId: target.userId, from: target.role, to: input.role };
      });
      if (change) {
        await recordActivity(ctx.prisma, {
          orgId: input.orgId,
          userId: ctx.user.id,
          action: "member.role_changed",
          resourceType: "member",
          resourceId: change.userId,
          metadata: { subjectUserId: change.userId, from: change.from, to: change.to },
          sourceKey: directKey("role"),
        });
      }
      return { memberId: input.memberId, role: input.role };
    }),

  /**
   * Remove a member, or leave (memberId of your own membership). The last owner
   * can't leave. API keys the member created in this org are revoked.
   */
  removeMember: protectedProcedure.input(z.object({ orgId, memberId: id })).mutation(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, input.orgId, "org:read");
    const removed = await prisma.$transaction(async (tx) => {
      await lockOrg(tx, input.orgId);
      const actorRole = await currentRole(tx, input.orgId, ctx.user.id);
      const target = found(
        await tx.orgMember.findFirst({
          where: { id: input.memberId, orgId: input.orgId, joinedAt: { not: null } },
          select: { id: true, userId: true, role: true },
        }),
        "Member"
      );
      const self = target.userId === ctx.user.id;
      if (!self) {
        if (!can(actorRole, "members:manage")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to remove members" });
        }
        if (target.role === "OWNER" && !can(actorRole, "owners:manage")) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can remove an owner" });
        }
      }
      await assertNotLastOwner(tx, input.orgId, target.role);
      await tx.orgMember.delete({ where: { id: target.id } });
      const revokedKeys = await revokeMemberApiKeys(tx, input.orgId, target.userId);
      return { userId: target.userId, self, revokedKeys };
    });
    await emitEvent({
      orgId: input.orgId,
      type: "member.removed",
      payload: { userId: removed.userId },
      actorUserId: ctx.user.id,
    });
    return { memberId: input.memberId, left: removed.self, revokedApiKeys: removed.revokedKeys };
  }),

  /** Make another member the owner; the caller becomes an admin. */
  transferOwnership: protectedProcedure.input(z.object({ orgId, memberId: id })).mutation(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, input.orgId, "owners:manage");
    const target = await prisma.$transaction(async (tx) => {
      await lockOrg(tx, input.orgId);
      const actorRole = await currentRole(tx, input.orgId, ctx.user.id);
      if (actorRole !== "OWNER") throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can transfer ownership" });
      const t = found(
        await tx.orgMember.findFirst({
          where: { id: input.memberId, orgId: input.orgId, joinedAt: { not: null } },
          select: { id: true, userId: true },
        }),
        "Member"
      );
      if (t.userId === ctx.user.id) throw new TRPCError({ code: "BAD_REQUEST", message: "You already own this organization" });
      await tx.orgMember.update({ where: { id: t.id }, data: { role: "OWNER" } });
      await tx.orgMember.update({ where: { orgId_userId: { orgId: input.orgId, userId: ctx.user.id } }, data: { role: "ADMIN" } });
      return t;
    });
    await recordActivity(ctx.prisma, {
      orgId: input.orgId,
      userId: ctx.user.id,
      action: "org.ownership_transferred",
      resourceType: "member",
      resourceId: target.userId,
      metadata: { subjectUserId: target.userId },
      sourceKey: directKey("transfer"),
    });
    return { ownerMemberId: target.id };
  }),

  /** Delete an organization with all its projects and stored files. Owners only; type the name to confirm. */
  delete: protectedProcedure
    .input(z.object({ orgId, confirmName: z.string().max(200) }))
    .mutation(async ({ ctx, input }) => {
      await requireOrgPermission(ctx, input.orgId, "owners:manage");
      const org = found(
        await ctx.prisma.organization.findUnique({ where: { id: input.orgId }, select: { id: true, name: true, isPersonal: true } }),
        "Organization"
      );
      if (org.isPersonal) throw new TRPCError({ code: "BAD_REQUEST", message: "Your personal workspace can't be deleted" });
      if (input.confirmName.trim() !== org.name.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Type the organization name exactly to confirm" });
      }
      const projects = await ctx.prisma.project.findMany({ where: { orgId: org.id }, select: { id: true } });
      await ctx.prisma.organization.delete({ where: { id: org.id } });

      const storage = getStorage();
      let purgeFailures = 0;
      for (const p of projects) {
        await storage.deletePrefix(projectPrefix(p.id)).catch((err) => {
          purgeFailures++;
          logger.error("failed to purge project objects after org deletion", { orgId: org.id, projectId: p.id, err });
        });
      }
      return { id: org.id, deletedProjects: projects.length, purgeFailures };
    }),
});
