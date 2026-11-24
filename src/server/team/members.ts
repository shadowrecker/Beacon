/**
 * Membership rules shared by the organization router and account deletion.
 *
 * - Only an OWNER may grant or revoke the OWNER role, or remove an OWNER.
 * - An organization always keeps at least one OWNER (last-owner invariant).
 * - Membership mutations of one org are serialized by locking the org row, so
 *   two owners demoting each other concurrently can't leave it ownerless.
 */
import type { OrgMemberRole, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { can } from "../auth/access";

type Tx = Prisma.TransactionClient;

/** Lock the organization row for the rest of the transaction. NOT_FOUND if it doesn't exist. */
export async function lockOrg(tx: Tx, orgId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
  if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
}

export async function ownerCount(tx: Tx, orgId: string): Promise<number> {
  return tx.orgMember.count({ where: { orgId, role: "OWNER", joinedAt: { not: null } } });
}

/** The caller's joined membership, read inside the transaction (after the lock). */
export async function currentRole(tx: Tx, orgId: string, userId: string): Promise<OrgMemberRole> {
  const m = await tx.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { role: true, joinedAt: true } });
  if (!m?.joinedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });
  return m.role;
}

export function assertMayChangeRole(actorRole: OrgMemberRole, from: OrgMemberRole, to: OrgMemberRole): void {
  if (!can(actorRole, "members:manage")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to change roles" });
  }
  if ((from === "OWNER" || to === "OWNER") && !can(actorRole, "owners:manage")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can grant or remove the owner role" });
  }
}

export const LAST_OWNER_MESSAGE =
  "An organization must have at least one owner. Make someone else an owner (or transfer ownership) first.";

export async function assertNotLastOwner(tx: Tx, orgId: string, role: OrgMemberRole): Promise<void> {
  if (role !== "OWNER") return;
  if ((await ownerCount(tx, orgId)) <= 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: LAST_OWNER_MESSAGE });
  }
}

/** Revoke API keys a departing member created in the org (they keep working otherwise). */
export async function revokeMemberApiKeys(tx: Tx, orgId: string, userId: string): Promise<number> {
  const res = await tx.apiKey.updateMany({
    where: { orgId, createdBy: userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count;
}
