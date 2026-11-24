import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { addMember, createOrg, createProject, createUser, type TestUser } from "../helpers/factories";
import { teamCaller, installFakeIdentity } from "./helpers";

installFakeIdentity();

async function themeIn(projectId: string, name = "Slow onboarding") {
  const synthesis = await prisma.synthesis.create({ data: { projectId, type: "THEMES", status: "READY", completedAt: new Date() } });
  return prisma.theme.create({
    data: { synthesisId: synthesis.id, name, description: "d", sentiment: "NEGATIVE", confidenceScore: 0.8 },
  });
}

const mention = (u: TestUser) => `@[${u.name}](user:${u.id})`;

async function setup() {
  const owner = await createUser({ name: "Owner Olga" });
  const member = await createUser({ name: "Member Max", email: "max@example.test" });
  const viewer = await createUser({ name: "Viewer Vic" });
  const outsider = await createUser({ name: "Outsider Oz", email: "oz@example.test" });
  const org = await createOrg(owner);
  await addMember(org.id, member, "MEMBER");
  await addMember(org.id, viewer, "VIEWER");
  const project = await createProject(owner, org.id);
  const theme = await themeIn(project.id);
  return { owner, member, viewer, outsider, org, project, theme };
}

describe("collaboration.addComment", () => {
  it("adds a comment on a target in the project and emits comment.created with org-member mentions", async () => {
    const { owner, member, project, theme } = await setup();
    const res = await teamCaller(owner).collaboration.addComment({
      projectId: project.id,
      targetType: "THEME",
      targetId: theme.id,
      content: `What do you think ${mention(member)}?`,
    });
    expect(res.mentionedUserIds).toEqual([member.id]);
    const event = await prisma.domainEvent.findFirstOrThrow({ where: { type: "comment.created" } });
    expect(event).toMatchObject({ projectId: project.id, actorUserId: owner.id });
    expect(event.payload).toEqual({ commentId: res.id, targetType: "THEME", targetId: theme.id, mentionedUserIds: [member.id] });
  });

  it("rejects targets that belong to another project", async () => {
    const { owner, project } = await setup();
    const otherProject = await createProject(owner);
    const foreignTheme = await themeIn(otherProject.id);
    const foreignRec = await prisma.recommendation.create({
      data: { projectId: otherProject.id, title: "r", description: "d", impact: "HIGH", confidence: 0.5 },
    });
    const caller = teamCaller(owner).collaboration;
    await expect(
      caller.addComment({ projectId: project.id, targetType: "THEME", targetId: foreignTheme.id, content: "hi" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.addComment({ projectId: project.id, targetType: "RECOMMENDATION", targetId: foreignRec.id, content: "hi" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.addComment({ projectId: project.id, targetType: "DOCUMENT", targetId: "doesnotexist00", content: "hi" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.comment.count()).toBe(0);
  });

  it("rejects mentions of people outside the org and never resolves plain @handles outside it", async () => {
    const { owner, outsider, member, project, theme } = await setup();
    const caller = teamCaller(owner).collaboration;
    await expect(
      caller.addComment({ projectId: project.id, targetType: "THEME", targetId: theme.id, content: `hey ${mention(outsider)}` })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.comment.count()).toBe(0);

    // Plain handles: @max is a member's local-part; @oz belongs to an outsider.
    const res = await caller.addComment({ projectId: project.id, targetType: "THEME", targetId: theme.id, content: "cc @max and @oz" });
    expect(res.mentionedUserIds).toEqual([member.id]);
  });

  it("blocks viewers and outsiders", async () => {
    const { viewer, outsider, project, theme } = await setup();
    const input = { projectId: project.id, targetType: "THEME" as const, targetId: theme.id, content: "hello" };
    await expect(teamCaller(viewer).collaboration.addComment(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(teamCaller(outsider).collaboration.addComment(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      teamCaller(outsider).collaboration.getComments({ projectId: project.id, targetType: "THEME", targetId: theme.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("collaboration.getComments / edit / delete", () => {
  it("returns paginated threads with replies and current mention names", async () => {
    const { owner, member, viewer, project, theme } = await setup();
    const asOwner = teamCaller(owner).collaboration;
    const base = { projectId: project.id, targetType: "THEME" as const, targetId: theme.id };
    const first = await asOwner.addComment({ ...base, content: `First ${mention(member)}` });
    await teamCaller(member).collaboration.addComment({ ...base, content: "A reply", parentId: first.id });
    const nested = await asOwner.addComment({ ...base, content: "Reply to the reply", parentId: first.id });
    expect(nested.parentId).toBe(first.id);
    for (let i = 0; i < 3; i++) await asOwner.addComment({ ...base, content: `Root ${i}` });

    await prisma.user.update({ where: { id: member.id }, data: { name: "Maxine" } });
    const page1 = await teamCaller(viewer).collaboration.getComments({ ...base, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.canComment).toBe(false);
    expect(page1.items[0]).toMatchObject({ id: first.id, replyCount: 2, mentions: [{ id: member.id, name: "Maxine" }], canDelete: false });
    expect(page1.items[0].replies.map((r) => r.content)).toEqual(["A reply", "Reply to the reply"]);
    const page2 = await teamCaller(viewer).collaboration.getComments({ ...base, limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((c) => c.content)).toEqual(["Root 1", "Root 2"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("lets authors edit, and authors or admins delete", async () => {
    const { owner, member, project, theme } = await setup();
    const admin = await createUser();
    await addMember(project.orgId, admin, "ADMIN");
    const base = { projectId: project.id, targetType: "THEME" as const, targetId: theme.id };
    const c = await teamCaller(member).collaboration.addComment({ ...base, content: "original" });

    await expect(teamCaller(owner).collaboration.editComment({ projectId: project.id, commentId: c.id, content: "hijack" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await teamCaller(member).collaboration.editComment({ projectId: project.id, commentId: c.id, content: "edited" });
    expect((await prisma.comment.findUniqueOrThrow({ where: { id: c.id } })).content).toBe("edited");

    const other = await createUser();
    await addMember(project.orgId, other, "MEMBER");
    await expect(teamCaller(other).collaboration.deleteComment({ projectId: project.id, commentId: c.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A comment ID paired with another project is NOT_FOUND.
    const otherProject = await createProject(owner, project.orgId);
    await expect(teamCaller(admin).collaboration.deleteComment({ projectId: otherProject.id, commentId: c.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await teamCaller(admin).collaboration.deleteComment({ projectId: project.id, commentId: c.id });
    expect(await prisma.comment.count()).toBe(0);
  });

  it("notifies people newly mentioned in an edit", async () => {
    const { owner, member, project, theme } = await setup();
    const c = await teamCaller(owner).collaboration.addComment({ projectId: project.id, targetType: "THEME", targetId: theme.id, content: "draft" });
    await teamCaller(owner).collaboration.editComment({ projectId: project.id, commentId: c.id, content: `now with ${mention(member)}` });
    const notes = await prisma.notification.findMany({ where: { userId: member.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ type: "COMMENT_MENTION", resourceType: "comment", resourceId: c.id });
  });
});

describe("notifications procedures", () => {
  it("lists, counts and marks only the caller's notifications", async () => {
    const a = await createUser();
    const b = await createUser();
    const project = await createProject(a);
    const synthesis = await prisma.synthesis.create({ data: { projectId: project.id, type: "THEMES", status: "READY" } });
    for (let i = 0; i < 3; i++) {
      await prisma.notification.create({
        data: { userId: a.id, type: "SYNTHESIS_COMPLETE", title: `n${i}`, message: "m", resourceType: "synthesis", resourceId: synthesis.id },
      });
    }
    const bNote = await prisma.notification.create({ data: { userId: b.id, type: "SYSTEM", title: "b", message: "m" } });

    const asA = teamCaller(a).collaboration;
    expect(await asA.unreadCount()).toEqual({ count: 3 });
    const page = await asA.getNotifications({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].href).toBe(`/projects/${project.id}/synthesis`);
    expect(page.nextCursor).not.toBeNull();

    // Marking someone else's notification does nothing.
    expect(await asA.markRead({ ids: [bNote.id, page.items[0].id] })).toEqual({ updated: 1 });
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: bNote.id } })).isRead).toBe(false);
    expect(await asA.unreadCount()).toEqual({ count: 2 });
    expect((await asA.getNotifications({ unreadOnly: true })).items).toHaveLength(2);
    expect(await asA.markAllRead()).toEqual({ updated: 2 });
    expect(await asA.unreadCount()).toEqual({ count: 0 });
    expect(await teamCaller(b).collaboration.unreadCount()).toEqual({ count: 1 });
  });
});
