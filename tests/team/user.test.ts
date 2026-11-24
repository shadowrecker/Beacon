import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { storage } from "../helpers/doubles";
import { identity, teamCaller, installFakeIdentity } from "./helpers";

installFakeIdentity();

describe("user.me / update", () => {
  it("returns the profile with effective notification preferences and memberships", async () => {
    const user = await createUser({ name: "Pat" });
    const other = await createUser();
    const org = await createOrg(other, { name: "Shared" });
    await addMember(org.id, user, "MEMBER");
    const me = await teamCaller(user).user.me();
    expect(me).toMatchObject({ id: user.id, name: "Pat", email: user.email });
    expect(me.notificationPrefs.COMMENT_MENTION).toEqual({ email: true });
    expect(me.notificationPrefs.SYNTHESIS_COMPLETE).toEqual({ email: false });
    expect(me.memberships.map((m) => [m.name, m.role])).toEqual([
      [`Pat's workspace`, "OWNER"],
      ["Shared", "MEMBER"],
    ]);
  });

  it("merges notification preferences and validates their keys", async () => {
    const user = await createUser();
    const caller = teamCaller(user).user;
    await caller.update({ notificationPrefs: { COMMENT_MENTION: { email: false } } });
    await caller.update({ notificationPrefs: { SYNTHESIS_COMPLETE: { email: true } } });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { notificationPrefs: true } });
    expect(stored.notificationPrefs).toEqual({ COMMENT_MENTION: { email: false }, SYNTHESIS_COMPLETE: { email: true } });
    await expect(
      caller.update({ notificationPrefs: { NOT_A_TYPE: { email: true } } as unknown as Record<string, { email: boolean }> })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.update({})).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("keeps the identity provider's name in sync", async () => {
    const user = await createUser();
    await teamCaller(user).user.update({ name: "  Mary   Ann Smith " });
    expect(identity.renamed).toEqual([{ clerkId: user.clerkId, name: "Mary Ann Smith" }]);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).name).toBe("Mary Ann Smith");
  });
});

describe("user.exportData", () => {
  it("exports only the caller's own data", async () => {
    const user = await createUser();
    const other = await createUser();
    const project = await createProject(user);
    await prisma.query.create({ data: { projectId: project.id, userId: user.id, question: "Why churn?", answer: "Pricing." } });
    await prisma.query.create({ data: { projectId: project.id, userId: other.id, question: "Not mine", answer: "x" } });
    await prisma.notification.create({ data: { userId: user.id, type: "SYSTEM", title: "mine", message: "m" } });
    await prisma.notification.create({ data: { userId: other.id, type: "SYSTEM", title: "theirs", message: "m" } });
    await prisma.decisionLog.create({ data: { projectId: project.id, userId: user.id, decision: "Ship it", reasoning: "Evidence" } });

    const data = await teamCaller(user).user.exportData();
    expect(data.format).toBe("beacon.user-export.v1");
    expect(data.profile.id).toBe(user.id);
    expect(data.queries.map((q) => q.question)).toEqual(["Why churn?"]);
    expect(data.notifications.map((n) => n.title)).toEqual(["mine"]);
    expect(data.decisionLogs.map((d) => d.decision)).toEqual(["Ship it"]);
    expect(data.memberships).toHaveLength(1);
    expect(data.truncated).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("Not mine");
  });
});

describe("user.deleteAccount", () => {
  it("is blocked while the user is the only owner of a shared org", async () => {
    const user = await createUser();
    const teammate = await createUser();
    const org = await createOrg(user, { name: "Team A" });
    await addMember(org.id, teammate, "MEMBER");
    expect(await teamCaller(user).user.deletionBlockers()).toEqual([{ id: org.id, name: "Team A" }]);
    await expect(teamCaller(user).user.deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(identity.deleted).toEqual([]);
  });

  it("deletes the identity, personal data and files, and keeps shared projects with the team", async () => {
    const user = await createUser();
    const teamOwner = await createUser();
    const shared = await createOrg(teamOwner);
    await addMember(shared.id, user, "MEMBER");
    const personalProject = await createProject(user);
    const sharedProject = await createProject(user, shared.id, "Team research");
    await prisma.comment.create({
      data: { userId: user.id, projectId: sharedProject.id, targetType: "DOCUMENT", targetId: "doc123456789", content: "my words" },
    });
    await storage.put(`projects/${personalProject.id}/documents/a/f.txt`, Buffer.from("pii"), "text/plain");
    await storage.put(`projects/${sharedProject.id}/documents/b/f.txt`, Buffer.from("team"), "text/plain");

    await expect(teamCaller(user).user.deleteAccount({ confirm: "DELETE" })).resolves.toEqual({ deleted: true });
    expect(identity.deleted).toEqual([user.clerkId]);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.organization.findUnique({ where: { id: user.personalOrgId } })).toBeNull();
    expect(await prisma.project.findUnique({ where: { id: personalProject.id } })).toBeNull();
    expect(await prisma.comment.count({ where: { content: "my words" } })).toBe(0);
    // The team's project survives, re-attributed to its owner, with its files.
    expect(await prisma.project.findUnique({ where: { id: sharedProject.id } })).toMatchObject({ userId: teamOwner.id, orgId: shared.id });
    expect([...storage.objects.keys()]).toEqual([`projects/${sharedProject.id}/documents/b/f.txt`]);
  });

  it("leaves everything intact when the identity provider fails", async () => {
    const user = await createUser();
    identity.failDelete = true;
    await expect(teamCaller(user).user.deleteAccount({ confirm: "DELETE" })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it("requires typing DELETE", async () => {
    const user = await createUser();
    await expect(teamCaller(user).user.deleteAccount({ confirm: "delete" } as unknown as { confirm: "DELETE" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
