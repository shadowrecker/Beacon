import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { notify } from "@/server/notifications/notify";
import { notificationsSubscriber } from "@/server/events/subscribers/notifications";
import { teamActivitySubscriber } from "@/server/events/subscribers/team-activity";
import { EMAIL_DEFAULT_TYPES, NOTIFICATION_TYPES } from "@/server/team/preferences";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { jobsFor } from "../helpers/doubles";
import { teamCaller, installFakeIdentity } from "./helpers";

installFakeIdentity();

async function event(orgId: string, type: string, payload: Prisma.InputJsonValue, extra: { projectId?: string; actorUserId?: string | null } = {}) {
  return prisma.domainEvent.create({
    data: { orgId, type, payload, projectId: extra.projectId ?? null, actorUserId: extra.actorUserId ?? null },
  });
}

async function setup() {
  const owner = await createUser({ name: "Owner" });
  const admin = await createUser({ name: "Admin" });
  const member = await createUser({ name: "Member" });
  const org = await createOrg(owner, { name: "Acme" });
  await addMember(org.id, admin, "ADMIN");
  await addMember(org.id, member, "MEMBER");
  const project = await createProject(owner, org.id, "Research");
  const synthesis = await prisma.synthesis.create({
    data: { projectId: project.id, type: "THEMES", status: "READY", createdById: member.id, completedAt: new Date() },
  });
  const theme = await prisma.theme.create({
    data: { synthesisId: synthesis.id, name: "Pricing confusion", description: "d", sentiment: "NEGATIVE", confidenceScore: 0.7 },
  });
  return { owner, admin, member, org, project, synthesis, theme };
}

describe("notifications subscriber", () => {
  it("notifies mentioned members and the parent author once, even when re-run", async () => {
    const { owner, admin, member, org, project, theme } = await setup();
    const parent = await prisma.comment.create({
      data: { userId: admin.id, projectId: project.id, targetType: "THEME", targetId: theme.id, content: "root" },
    });
    const reply = await prisma.comment.create({
      data: {
        userId: owner.id,
        projectId: project.id,
        targetType: "THEME",
        targetId: theme.id,
        parentId: parent.id,
        content: `Agreed, @[Member](user:${member.id}) can you look?`,
      },
    });
    const evt = await event(
      org.id,
      "comment.created",
      { commentId: reply.id, targetType: "THEME", targetId: theme.id, mentionedUserIds: [member.id] },
      { projectId: project.id, actorUserId: owner.id }
    );

    await notificationsSubscriber.handle(evt, logger);
    await notificationsSubscriber.handle(evt, logger);

    const forMember = await prisma.notification.findMany({ where: { userId: member.id } });
    expect(forMember).toHaveLength(1);
    expect(forMember[0]).toMatchObject({ type: "COMMENT_MENTION", title: "Owner mentioned you", resourceType: "comment", resourceId: reply.id });
    expect(forMember[0].message).toContain("@Member can you look?");
    expect(forMember[0].message).toContain('"Pricing confusion" in Research');

    const forAdmin = await prisma.notification.findMany({ where: { userId: admin.id } });
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0]).toMatchObject({ type: "COMMENT_REPLY", title: "Owner replied to your comment" });
    expect(await prisma.notification.count({ where: { userId: owner.id } })).toBe(0);

    // Mentions email by default (one job per recipient, deduped by event id).
    const emails = jobsFor("email").filter((j) => (j.payload as { template: string }).template === "mention");
    expect(emails).toHaveLength(1);
    expect(emails[0].opts.jobId).toContain(evt.id);
  });

  it("never notifies users outside the org, even if an event names them", async () => {
    const { owner, org, project, theme } = await setup();
    const outsider = await createUser();
    const c = await prisma.comment.create({
      data: { userId: owner.id, projectId: project.id, targetType: "THEME", targetId: theme.id, content: "hi" },
    });
    const evt = await event(
      org.id,
      "comment.created",
      { commentId: c.id, targetType: "THEME", targetId: theme.id, mentionedUserIds: [outsider.id] },
      { projectId: project.id, actorUserId: owner.id }
    );
    await notificationsSubscriber.handle(evt, logger);
    expect(await prisma.notification.count({ where: { userId: outsider.id } })).toBe(0);
  });

  it("notifies the actor of a finished synthesis and new recommendations", async () => {
    const { member, org, project, synthesis } = await setup();
    await notificationsSubscriber.handle(
      await event(org.id, "synthesis.completed", { synthesisId: synthesis.id, themeCount: 4 }, { projectId: project.id }),
      logger
    );
    const run = await prisma.jobRun.create({ data: { kind: "RECOMMENDATIONS", orgId: org.id, projectId: project.id, createdById: member.id } });
    const rec = await prisma.recommendation.create({
      data: { projectId: project.id, title: "Simplify pricing", description: "d", impact: "HIGH", confidence: 0.82, runId: run.id },
    });
    await notificationsSubscriber.handle(
      await event(
        org.id,
        "recommendation.created",
        { recommendationId: rec.id, title: rec.title, impact: "HIGH", confidence: 0.82 },
        { projectId: project.id }
      ),
      logger
    );
    const notes = await prisma.notification.findMany({ where: { userId: member.id }, orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => n.type)).toEqual(["SYNTHESIS_COMPLETE", "RECOMMENDATION_GENERATED"]);
    expect(notes[0].message).toContain("4 themes");
    expect(notes[1].title).toBe("New recommendation: Simplify pricing");
  });

  it("alerts owners and admins about failed integrations, and owners about new members", async () => {
    const { owner, admin, member, org } = await setup();
    await notificationsSubscriber.handle(
      await event(org.id, "integration.failed", { integrationId: "int123456789", provider: "ZENDESK", error: "401 Unauthorized" }),
      logger
    );
    for (const u of [owner, admin]) {
      expect(await prisma.notification.findFirst({ where: { userId: u.id, type: "INTEGRATION_SYNC" } })).toMatchObject({
        title: "Zendesk sync failed",
      });
    }
    expect(await prisma.notification.count({ where: { userId: member.id } })).toBe(0);

    const joiner = await createUser({ name: "Newbie" });
    await addMember(org.id, joiner, "VIEWER");
    await notificationsSubscriber.handle(await event(org.id, "member.joined", { userId: joiner.id, role: "VIEWER" }, { actorUserId: joiner.id }), logger);
    expect(await prisma.notification.findFirst({ where: { userId: owner.id, type: "SYSTEM" } })).toMatchObject({ title: "Newbie joined Acme" });
    expect(await prisma.notification.count({ where: { userId: admin.id, type: "SYSTEM" } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: joiner.id } })).toBe(0);
  });

  it("ignores malformed payloads instead of failing forever", async () => {
    const { org } = await setup();
    await expect(notificationsSubscriber.handle(await event(org.id, "comment.created", { nope: true }), logger)).resolves.toBeUndefined();
  });
});

describe("team-activity subscriber", () => {
  it("writes one row per event, idempotently, and skips events without a person", async () => {
    const { owner, org, project } = await setup();
    const evt = await event(
      org.id,
      "document.uploaded",
      { documentId: "doc123456789", title: "Interview 3", source: "UPLOAD" },
      { projectId: project.id, actorUserId: owner.id }
    );
    expect(teamActivitySubscriber.handles("document.uploaded")).toBe(true);
    expect(teamActivitySubscriber.handles("document.ready")).toBe(false);
    await teamActivitySubscriber.handle(evt, logger);
    await teamActivitySubscriber.handle(evt, logger);
    const rows = await prisma.teamActivity.findMany({ where: { orgId: org.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.id, projectId: project.id, action: "document.uploaded", resourceType: "document" });
    expect(rows[0].metadata).toMatchObject({ eventId: evt.id, title: "Interview 3" });

    await teamActivitySubscriber.handle(
      await event(org.id, "integration.synced", { integrationId: "int123456789", provider: "GONG", records: 3 }),
      logger
    );
    expect(await prisma.teamActivity.count({ where: { orgId: org.id } })).toBe(1);

    const feed = await teamCaller(owner, org.id).team.activityFeed({});
    expect(feed.items[0]).toMatchObject({
      actor: { name: "Owner" },
      summary: 'added the document "Interview 3"',
      project: { id: project.id, name: "Research" },
      href: `/projects/${project.id}/documents`,
    });
  });

  it("attributes a synthesis without an explicit actor to whoever started it", async () => {
    const { member, org, project, synthesis } = await setup();
    await teamActivitySubscriber.handle(
      await event(org.id, "synthesis.completed", { synthesisId: synthesis.id, themeCount: 2 }, { projectId: project.id }),
      logger
    );
    expect(await prisma.teamActivity.findFirst({ where: { orgId: org.id } })).toMatchObject({ userId: member.id, action: "synthesis.completed" });
  });
});

describe("notification preferences", () => {
  it("defaults match the email defaults notify() applies", async () => {
    for (const type of NOTIFICATION_TYPES) {
      const u = await createUser();
      const before = jobsFor("email").length;
      await notify({ userIds: [u.id], type, title: `t-${type}`, message: "m", dedupeKey: `pref-${type}-${u.id}` });
      const emailed = jobsFor("email").length > before;
      expect(emailed, type).toBe(EMAIL_DEFAULT_TYPES.has(type));
    }
  });
});
