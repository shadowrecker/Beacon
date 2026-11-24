/**
 * Organization invitations.
 *
 * The raw token (256-bit) is emailed once and never stored: OrgInvite keeps only
 * its SHA-256. Acceptance requires the signed-in user to have *verified* the
 * invited email address with the identity provider. Inviting responds the same
 * way whether or not the address belongs to an existing Beacon account.
 */
import type { OrgInvite, OrgMemberRole } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { prisma, type DbClient } from "@/lib/db";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { enqueue, QUEUE } from "../jobs/queues";
import { emitEvent } from "../events/bus";
import { RESOURCE } from "../collaboration/links";
import { getIdentityProvider } from "./identity";
import { displayName } from "./format";

export const INVITE_TTL_MS = 7 * 24 * 3600_000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashInviteToken(token: string): string {
  return sha256Hex(token);
}

export function appUrl(): string {
  return (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export type InviteStatus = "pending" | "expired" | "revoked" | "accepted";

export function inviteStatus(invite: Pick<OrgInvite, "acceptedAt" | "revokedAt" | "expiresAt">, now = new Date()): InviteStatus {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  if (invite.expiresAt <= now) return "expired";
  return "pending";
}

/**
 * Create or refresh the invite for (org, email) with a fresh token and a new
 * 7-day expiry, then email the link. Any previous link for it stops working.
 */
export async function issueInvite(
  db: DbClient,
  input: { orgId: string; email: string; role: OrgMemberRole },
  inviter: { id: string; name: string | null; email: string | null }
): Promise<{ id: string; email: string; role: OrgMemberRole; expiresAt: Date; orgName: string }> {
  const token = randomToken(32);
  const tokenHash = hashInviteToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invite = await db.orgInvite.upsert({
    where: { orgId_email: { orgId: input.orgId, email: input.email } },
    create: { orgId: input.orgId, email: input.email, role: input.role, tokenHash, expiresAt, invitedById: inviter.id },
    update: { role: input.role, tokenHash, expiresAt, invitedById: inviter.id, revokedAt: null, acceptedAt: null, createdAt: new Date() },
    select: { id: true, email: true, role: true, expiresAt: true, organization: { select: { name: true } } },
  });
  await enqueue(
    QUEUE.EMAIL,
    {
      to: invite.email,
      template: "org-invite",
      data: {
        orgName: invite.organization.name,
        inviterName: displayName(inviter),
        role: invite.role,
        acceptUrl: `${appUrl()}/invite/${token}`,
        expiresAt: expiresAt.toISOString(),
      },
      dedupeKey: `invite:${invite.id}:${tokenHash.slice(0, 32)}`,
    },
    { jobId: `email_invite_${invite.id}_${tokenHash.slice(0, 16)}` }
  );
  await upsertInviteNotification(db, {
    id: invite.id,
    email: invite.email,
    orgName: invite.organization.name,
    inviterName: displayName(inviter),
  });
  return { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, orgName: invite.organization.name };
}

/**
 * In-app notice for an invitee who already has an account (in addition to the
 * email). Never visible to the inviter, so it doesn't reveal account existence.
 */
export async function upsertInviteNotification(
  db: DbClient,
  invite: { id: string; email: string; orgName: string; inviterName: string }
): Promise<void> {
  const user = await db.user.findUnique({ where: { email: invite.email }, select: { id: true } });
  if (!user) return;
  await db.notification.deleteMany({ where: { userId: user.id, resourceType: RESOURCE.ORG_INVITE, resourceId: invite.id } });
  await db.notification.create({
    data: {
      userId: user.id,
      type: "ORG_INVITE",
      title: `You're invited to join ${invite.orgName}`.slice(0, 200),
      message: `${invite.inviterName} invited you to join ${invite.orgName} on Beacon.`.slice(0, 2000),
      resourceType: RESOURCE.ORG_INVITE,
      resourceId: invite.id,
    },
  });
}

export async function clearInviteNotifications(db: DbClient, inviteId: string): Promise<void> {
  await db.notification.deleteMany({ where: { resourceType: RESOURCE.ORG_INVITE, resourceId: inviteId } });
}

/** Lower-cased verified emails of the signed-in user (from the identity provider). */
export async function verifiedEmailsOf(user: { clerkId: string }): Promise<string[]> {
  try {
    return (await getIdentityProvider().getVerifiedEmails(user.clerkId)).map(normalizeEmail);
  } catch {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not verify your email address. Please try again." });
  }
}

export type InviteLookup = { token: string } | { inviteId: string };

export async function findInvite(db: DbClient, lookup: InviteLookup) {
  const where = "token" in lookup ? { tokenHash: hashInviteToken(lookup.token) } : { id: lookup.inviteId };
  return db.orgInvite.findUnique({
    where,
    select: {
      id: true,
      orgId: true,
      email: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
      organization: { select: { id: true, name: true, isPersonal: true } },
      invitedBy: { select: { name: true, email: true } },
    },
  });
}

const STATUS_MESSAGES: Record<Exclude<InviteStatus, "pending">, string> = {
  accepted: "This invitation has already been accepted.",
  revoked: "This invitation was revoked or declined. Ask for a new one.",
  expired: "This invitation has expired. Ask the person who invited you to send a new one.",
};

/** Load a pending invite addressed to one of the user's verified emails, or throw. */
export async function requireAcceptableInvite(lookup: InviteLookup, user: { id: string; clerkId: string }) {
  const invite = await findInvite(prisma, lookup);
  if (!invite) throw new TRPCError({ code: "NOT_FOUND", message: "This invitation link is not valid." });
  const verified = await verifiedEmailsOf(user);
  if (!verified.includes(normalizeEmail(invite.email))) {
    // Same answer whatever the invite's state, so the link can't be probed by another account.
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This invitation was sent to a different email address. Sign in with that address to accept it.",
    });
  }
  const status = inviteStatus(invite);
  if (status !== "pending") throw new TRPCError({ code: "BAD_REQUEST", message: STATUS_MESSAGES[status] });
  return invite;
}

/** Accept: join the org with the invited role (keeping a higher existing role). */
export async function acceptInvite(lookup: InviteLookup, user: { id: string; clerkId: string }) {
  const invite = await requireAcceptableInvite(lookup, user);
  const rank: Record<OrgMemberRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

  const result = await prisma.$transaction(async (tx) => {
    // Claim the invite atomically so two concurrent accepts can't both succeed.
    const claimed = await tx.orgInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date() },
    });
    if (claimed.count !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation is no longer valid." });

    const existing = await tx.orgMember.findUnique({
      where: { orgId_userId: { orgId: invite.orgId, userId: user.id } },
      select: { id: true, role: true, joinedAt: true },
    });
    if (existing?.joinedAt) {
      const role = rank[invite.role] > rank[existing.role] ? invite.role : existing.role;
      if (role !== existing.role) await tx.orgMember.update({ where: { id: existing.id }, data: { role } });
      return { role, newlyJoined: false };
    }
    if (existing) {
      await tx.orgMember.update({ where: { id: existing.id }, data: { role: invite.role, joinedAt: new Date() } });
    } else {
      await tx.orgMember.create({ data: { orgId: invite.orgId, userId: user.id, role: invite.role, joinedAt: new Date() } });
    }
    return { role: invite.role, newlyJoined: true };
  });

  await clearInviteNotifications(prisma, invite.id);
  if (result.newlyJoined) {
    await emitEvent({
      orgId: invite.orgId,
      type: "member.joined",
      payload: { userId: user.id, role: result.role },
      actorUserId: user.id,
    });
  }
  return { orgId: invite.orgId, orgName: invite.organization.name, role: result.role };
}

/** Decline: the invite can no longer be used and disappears from the pending list. */
export async function declineInvite(lookup: InviteLookup, user: { id: string; clerkId: string }) {
  const invite = await requireAcceptableInvite(lookup, user);
  await prisma.orgInvite.updateMany({ where: { id: invite.id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  await clearInviteNotifications(prisma, invite.id);
  return { id: invite.id };
}
