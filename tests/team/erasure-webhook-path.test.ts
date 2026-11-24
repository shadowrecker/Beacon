/**
 * Erasure through the Clerk `user.deleted` webhook path (deleteUserData), which
 * runs when an account is deleted outside Beacon's own flow (e.g. from the Clerk
 * dashboard). Shared team work must be re-attributed, never cascaded away.
 */
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { deleteUserData } from "@/server/auth/provision";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";

describe("deleteUserData (webhook path)", () => {
  it("keeps a team's projects created by the deleted member, re-attributed to a remaining member", async () => {
    const owner = await createUser();
    const member = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, member, "MEMBER");
    const shared = await createProject(member, org.id, "Shared roadmap research");
    const personal = await createProject(member, member.personalOrgId, "Private notes");

    const { deletedProjectIds } = await deleteUserData(member.clerkId);

    // The team project survives and now belongs to the remaining member.
    const kept = await prisma.project.findUnique({ where: { id: shared.id } });
    expect(kept).not.toBeNull();
    expect(kept!.userId).toBe(owner.id);
    // The member's personal workspace (sole member) is erased, and its project
    // is reported for storage purge.
    expect(await prisma.project.findUnique({ where: { id: personal.id } })).toBeNull();
    expect(deletedProjectIds).toContain(personal.id);
    expect(deletedProjectIds).not.toContain(shared.id);
    expect(await prisma.user.findUnique({ where: { id: member.id } })).toBeNull();
  });
});
