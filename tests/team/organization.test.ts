import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { jobsFor, storage } from "../helpers/doubles";
import { identity, lastInviteToken, teamCaller, installFakeIdentity } from "./helpers";

installFakeIdentity();

describe("organization.listMine", () => {
  it("returns exactly the switcher contract for joined memberships, personal first", async () => {
    const user = await createUser({ name: "Zed" });
    const other = await createUser();
    const org = await createOrg(other, { name: "Acme", plan: "TEAM" });
    await addMember(org.id, user, "ADMIN");
    // A pending (not joined) membership is not listed.
    const pendingOrg = await createOrg(other, { name: "Pending Co" });
    await prisma.orgMember.create({ data: { orgId: pendingOrg.id, userId: user.id, role: "MEMBER" } });

    const list = await teamCaller(user).organization.listMine();
    expect(list).toHaveLength(2);
    for (const o of list) expect(Object.keys(o).sort()).toEqual(["id", "isPersonal", "name", "plan", "role", "slug"]);
    expect(list[0]).toMatchObject({ id: user.personalOrgId, isPersonal: true, role: "OWNER" });
    expect(list[1]).toEqual({ id: org.id, name: "Acme", slug: org.slug, isPersonal: false, role: "ADMIN", plan: "TEAM" });
  });
});

describe("organization.create / update", () => {
  it("makes the creator the joined OWNER and keeps slugs unique", async () => {
    const user = await createUser();
    const a = await teamCaller(user).organization.create({ name: "Product Team" });
    const b = await teamCaller(user).organization.create({ name: "Product Team" });
    expect(a.slug).toBe("product-team");
    expect(b.slug).not.toBe(a.slug);
    const m = await prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: a.id, userId: user.id } } });
    expect(m.role).toBe("OWNER");
    expect(m.joinedAt).not.toBeNull();
    expect(a.plan).toBe("FREE");
  });

  it("never changes the plan through update", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    const caller = teamCaller(owner);
    await expect(
      caller.organization.update({ orgId: org.id, name: "Renamed", plan: "ENTERPRISE" } as unknown as { orgId: string; name: string })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller.organization.update({ orgId: org.id, name: "Renamed" });
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after).toMatchObject({ name: "Renamed", plan: "FREE" });
  });

  it("blocks viewers and hides the org from outsiders", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const outsider = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, viewer, "VIEWER");
    await expect(teamCaller(viewer).organization.update({ orgId: org.id, name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(teamCaller(outsider).organization.get({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(teamCaller(outsider).organization.listMembers({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("invitations", () => {
  it("emails a link, stores only the token hash, and the invited email can accept", async () => {
    const owner = await createUser({ name: "Olivia" });
    const invitee = await createUser({ email: "Invitee@Example.test" });
    await prisma.user.update({ where: { id: invitee.id }, data: { email: "invitee@example.test" } });
    const org = await createOrg(owner, { name: "Acme" });

    const res = await teamCaller(owner).organization.invite({ orgId: org.id, email: "INVITEE@example.test", role: "ADMIN" });
    expect(res.email).toBe("invitee@example.test");

    const token = lastInviteToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    const row = await prisma.orgInvite.findUniqueOrThrow({ where: { id: res.id } });
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
    const email = jobsFor("email").at(-1)!;
    expect(email.payload).toMatchObject({
      to: "invitee@example.test",
      template: "org-invite",
      data: { orgName: "Acme", inviterName: "Olivia", role: "ADMIN", acceptUrl: `http://localhost:3000/invite/${token}` },
    });

    // Not a member until accepted.
    await expect(teamCaller(invitee).organization.get({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const preview = await teamCaller(invitee).organization.getInvite({ token });
    expect(preview).toMatchObject({ found: true, status: "pending", orgName: "Acme", inviterName: "Olivia", emailMatches: true });

    const accepted = await teamCaller(invitee).organization.acceptInvite({ token });
    expect(accepted).toMatchObject({ orgId: org.id, role: "ADMIN" });
    const member = await prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: org.id, userId: invitee.id } } });
    expect(member.role).toBe("ADMIN");
    expect(member.joinedAt).not.toBeNull();
    expect((await prisma.orgInvite.findUniqueOrThrow({ where: { id: res.id } })).acceptedAt).not.toBeNull();
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { orgId: org.id, type: "member.joined" } });
    expect(event.payload).toEqual({ userId: invitee.id, role: "ADMIN" });

    // The link can't be reused.
    await expect(teamCaller(invitee).organization.acceptInvite({ token })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("answers identically for registered and unregistered emails", async () => {
    const owner = await createUser();
    await createUser({ email: "known@example.test" });
    const org = await createOrg(owner);
    const caller = teamCaller(owner);
    const known = await caller.organization.invite({ orgId: org.id, email: "known@example.test", role: "MEMBER" });
    const unknown = await caller.organization.invite({ orgId: org.id, email: "nobody@example.test", role: "MEMBER" });
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
    expect({ ...known, id: "x", email: "x", expiresAt: null }).toEqual({ ...unknown, id: "x", email: "x", expiresAt: null });
  });

  it("rejects a signed-in user whose verified emails don't include the invited address", async () => {
    const owner = await createUser();
    const intended = "intended@example.test";
    const attacker = await createUser({ email: "attacker@example.test" });
    const org = await createOrg(owner);
    await teamCaller(owner).organization.invite({ orgId: org.id, email: intended, role: "MEMBER" });
    const token = lastInviteToken();

    await expect(teamCaller(attacker).organization.acceptInvite({ token })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const preview = await teamCaller(attacker).organization.getInvite({ token });
    expect(preview).toMatchObject({ found: true, emailMatches: false });
    expect(preview.found && preview.invitedEmail).not.toBe(intended);

    // An unverified secondary address doesn't count; a verified one does.
    identity.verified.set(attacker.clerkId, ["attacker@example.test"]);
    await expect(teamCaller(attacker).organization.acceptInvite({ token })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.orgMember.count({ where: { orgId: org.id, userId: attacker.id } })).toBe(0);
    identity.verified.set(attacker.clerkId, ["attacker@example.test", intended]);
    await expect(teamCaller(attacker).organization.acceptInvite({ token })).resolves.toMatchObject({ orgId: org.id });
  });

  it("rejects expired and revoked invitations", async () => {
    const owner = await createUser();
    const a = await createUser({ email: "a@example.test" });
    const b = await createUser({ email: "b@example.test" });
    const org = await createOrg(owner);
    const caller = teamCaller(owner);

    const inviteA = await caller.organization.invite({ orgId: org.id, email: a.email, role: "MEMBER" });
    const tokenA = lastInviteToken();
    await prisma.orgInvite.update({ where: { id: inviteA.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(teamCaller(a).organization.acceptInvite({ token: tokenA })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/expired/i),
    });

    const inviteB = await caller.organization.invite({ orgId: org.id, email: b.email, role: "MEMBER" });
    const tokenB = lastInviteToken();
    await caller.organization.revokeInvite({ orgId: org.id, inviteId: inviteB.id });
    await expect(teamCaller(b).organization.acceptInvite({ token: tokenB })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.orgMember.count({ where: { orgId: org.id } })).toBe(1);

    // Resending issues a new token; the old one stops working.
    await caller.organization.resendInvite({ orgId: org.id, inviteId: inviteA.id });
    const fresh = lastInviteToken();
    expect(fresh).not.toBe(tokenA);
    await expect(teamCaller(a).organization.acceptInvite({ token: tokenA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(teamCaller(a).organization.acceptInvite({ token: fresh })).resolves.toMatchObject({ orgId: org.id });
  });

  it("lets the invitee decline, and lists invitations addressed to them", async () => {
    const owner = await createUser();
    const invitee = await createUser({ email: "decliner@example.test" });
    const org = await createOrg(owner, { name: "Declined Org" });
    await teamCaller(owner).organization.invite({ orgId: org.id, email: invitee.email, role: "VIEWER" });
    const mine = await teamCaller(invitee).organization.myInvites();
    expect(mine).toEqual([expect.objectContaining({ orgId: org.id, orgName: "Declined Org", role: "VIEWER" })]);
    // The existing account also got an in-app notice (the inviter can't see this).
    expect(await prisma.notification.count({ where: { userId: invitee.id, type: "ORG_INVITE" } })).toBe(1);

    await teamCaller(invitee).organization.declineInvite({ inviteId: mine[0].id });
    expect(await teamCaller(invitee).organization.myInvites()).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: invitee.id, type: "ORG_INVITE" } })).toBe(0);
    expect((await teamCaller(owner).organization.listInvites({ orgId: org.id })).items).toHaveLength(0);
  });

  it("enforces who may invite whom", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const member = await createUser();
    const viewer = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, admin, "ADMIN");
    await addMember(org.id, member, "MEMBER");
    await addMember(org.id, viewer, "VIEWER");

    await expect(teamCaller(viewer).organization.invite({ orgId: org.id, email: "x@example.test", role: "VIEWER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(teamCaller(member).organization.invite({ orgId: org.id, email: "x@example.test", role: "VIEWER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(teamCaller(admin).organization.invite({ orgId: org.id, email: "x@example.test", role: "OWNER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(teamCaller(admin).organization.invite({ orgId: org.id, email: "x@example.test", role: "ADMIN" })).resolves.toBeTruthy();
    await expect(teamCaller(owner).organization.invite({ orgId: org.id, email: "y@example.test", role: "OWNER" })).resolves.toBeTruthy();
    await expect(teamCaller(viewer).organization.listInvites({ orgId: org.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Existing members can't be re-invited.
    await expect(teamCaller(owner).organization.invite({ orgId: org.id, email: member.email, role: "ADMIN" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("enforces the plan's member limit (pending invitations count) and refuses personal workspaces", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    const caller = teamCaller(owner);
    await caller.organization.invite({ orgId: org.id, email: "one@example.test", role: "MEMBER" });
    await caller.organization.invite({ orgId: org.id, email: "two@example.test", role: "MEMBER" });
    await expect(caller.organization.invite({ orgId: org.id, email: "three@example.test", role: "MEMBER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Refreshing a pending invite doesn't need a new seat.
    await expect(caller.organization.invite({ orgId: org.id, email: "one@example.test", role: "ADMIN" })).resolves.toMatchObject({ role: "ADMIN" });

    await expect(
      caller.organization.invite({ orgId: owner.personalOrgId, email: "friend@example.test", role: "MEMBER" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("member roles and the last-owner invariant", () => {
  async function setup() {
    const owner = await createUser();
    const admin = await createUser();
    const member = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, admin, "ADMIN");
    await addMember(org.id, member, "MEMBER");
    const memberId = async (userId: string) =>
      (await prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: org.id, userId } } })).id;
    return { owner, admin, member, org, memberId };
  }

  it("lets admins manage non-owners but never grant or revoke OWNER", async () => {
    const { owner, admin, member, org, memberId } = await setup();
    const asAdmin = teamCaller(admin).organization;
    await expect(asAdmin.updateMemberRole({ orgId: org.id, memberId: await memberId(member.id), role: "VIEWER" })).resolves.toBeTruthy();
    await expect(asAdmin.updateMemberRole({ orgId: org.id, memberId: await memberId(member.id), role: "OWNER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(asAdmin.updateMemberRole({ orgId: org.id, memberId: await memberId(admin.id), role: "OWNER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(asAdmin.updateMemberRole({ orgId: org.id, memberId: await memberId(owner.id), role: "MEMBER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(asAdmin.removeMember({ orgId: org.id, memberId: await memberId(owner.id) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await prisma.orgMember.findUniqueOrThrow({ where: { id: await memberId(owner.id) } })).role).toBe("OWNER");

    await expect(
      teamCaller(member).organization.updateMemberRole({ orgId: org.id, memberId: await memberId(admin.id), role: "VIEWER" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps at least one owner", async () => {
    const { owner, admin, org, memberId } = await setup();
    const asOwner = teamCaller(owner).organization;
    const ownerMemberId = await memberId(owner.id);
    await expect(asOwner.updateMemberRole({ orgId: org.id, memberId: ownerMemberId, role: "ADMIN" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(asOwner.removeMember({ orgId: org.id, memberId: ownerMemberId })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // With a second owner, the first can step down or leave.
    await asOwner.updateMemberRole({ orgId: org.id, memberId: await memberId(admin.id), role: "OWNER" });
    await expect(asOwner.removeMember({ orgId: org.id, memberId: ownerMemberId })).resolves.toMatchObject({ left: true });
    expect(await prisma.orgMember.count({ where: { orgId: org.id, role: "OWNER" } })).toBe(1);
    // Personal workspace: its only owner can't leave.
    const personalMember = await prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: owner.personalOrgId, userId: owner.id } } });
    await expect(asOwner.removeMember({ orgId: owner.personalOrgId, memberId: personalMember.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("transfers ownership and records the change", async () => {
    const { owner, admin, org, memberId } = await setup();
    await expect(
      teamCaller(admin).organization.transferOwnership({ orgId: org.id, memberId: await memberId(admin.id) })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await teamCaller(owner).organization.transferOwnership({ orgId: org.id, memberId: await memberId(admin.id) });
    expect((await prisma.orgMember.findUniqueOrThrow({ where: { id: await memberId(admin.id) } })).role).toBe("OWNER");
    expect((await prisma.orgMember.findUniqueOrThrow({ where: { id: await memberId(owner.id) } })).role).toBe("ADMIN");
    expect(await prisma.teamActivity.count({ where: { orgId: org.id, action: "org.ownership_transferred" } })).toBe(1);
  });

  it("revokes API keys a removed member created in that org only", async () => {
    const { owner, member, org, memberId } = await setup();
    const otherOrg = await createOrg(member);
    const key = (orgId: string, n: string) =>
      prisma.apiKey.create({ data: { orgId, name: n, keyHash: sha256Hex(n + Math.random()), prefix: "bk_test", scopes: [], createdBy: member.id } });
    const inOrg = await key(org.id, "in-org");
    const elsewhere = await key(otherOrg.id, "elsewhere");
    const ownersKey = await prisma.apiKey.create({
      data: { orgId: org.id, name: "owner", keyHash: sha256Hex("owner-key"), prefix: "bk_test", scopes: [], createdBy: owner.id },
    });

    const res = await teamCaller(owner).organization.removeMember({ orgId: org.id, memberId: await memberId(member.id) });
    expect(res).toMatchObject({ left: false, revokedApiKeys: 1 });
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: inOrg.id } })).revokedAt).not.toBeNull();
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: elsewhere.id } })).revokedAt).toBeNull();
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: ownersKey.id } })).revokedAt).toBeNull();
    expect(await prisma.domainEvent.count({ where: { orgId: org.id, type: "member.removed" } })).toBe(1);
    await expect(teamCaller(member).organization.get({ orgId: org.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects member IDs from another org", async () => {
    const { owner, org } = await setup();
    const stranger = await createUser();
    const strangerOrg = await createOrg(stranger);
    const foreign = await prisma.orgMember.findUniqueOrThrow({ where: { orgId_userId: { orgId: strangerOrg.id, userId: stranger.id } } });
    await expect(teamCaller(owner).organization.updateMemberRole({ orgId: org.id, memberId: foreign.id, role: "VIEWER" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(teamCaller(owner).organization.removeMember({ orgId: org.id, memberId: foreign.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("organization.delete", () => {
  it("is owner-only, refuses personal workspaces, and purges project files", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const org = await createOrg(owner, { name: "Doomed" });
    await addMember(org.id, admin, "ADMIN");
    const project = await createProject(owner, org.id);
    await storage.put(`projects/${project.id}/documents/d1/file.txt`, Buffer.from("pii"), "text/plain");
    const keep = await createProject(owner);
    await storage.put(`projects/${keep.id}/documents/d2/file.txt`, Buffer.from("keep"), "text/plain");

    await expect(teamCaller(admin).organization.delete({ orgId: org.id, confirmName: "Doomed" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(teamCaller(owner).organization.delete({ orgId: org.id, confirmName: "doomed?" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      teamCaller(owner).organization.delete({ orgId: owner.personalOrgId, confirmName: "anything" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(teamCaller(owner).organization.delete({ orgId: org.id, confirmName: "Doomed" })).resolves.toMatchObject({ deletedProjects: 1 });
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toBeNull();
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect([...storage.objects.keys()]).toEqual([`projects/${keep.id}/documents/d2/file.txt`]);
  });
});
