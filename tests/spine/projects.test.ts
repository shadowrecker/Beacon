import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { PLAN_LIMITS } from "@/server/usage/entitlements";
import { storage } from "../helpers/doubles";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { callerFor } from "./helpers";

describe("project.list contract", () => {
  it("returns exactly { items: [{ id, name, description, createdAt, updatedAt, counts }], nextCursor }", async () => {
    const user = await createUser();
    const project = await createProject(user, undefined, "Checkout research");
    await prisma.document.create({ data: { projectId: project.id, title: "d", type: "NOTE", status: "READY" } });
    await prisma.synthesis.create({ data: { projectId: project.id, type: "FULL" } });

    const res = await callerFor(user).project.list({});
    expect(Object.keys(res).sort()).toEqual(["items", "nextCursor"]);
    expect(res.nextCursor).toBeNull();
    expect(res.items).toHaveLength(1);
    const item = res.items[0];
    expect(Object.keys(item).sort()).toEqual(["counts", "createdAt", "description", "id", "name", "updatedAt"]);
    expect(Object.keys(item.counts).sort()).toEqual(["documents", "recommendations", "syntheses"]);
    expect(item).toMatchObject({ id: project.id, name: "Checkout research", description: null, counts: { documents: 1, syntheses: 1, recommendations: 0 } });
    expect(item.createdAt).toBeInstanceOf(Date);
  });

  it("accepts no input and paginates with a cursor", async () => {
    const user = await createUser();
    for (let i = 0; i < 5; i++) await createProject(user, undefined, `p${i}`);
    const caller = callerFor(user);
    expect((await caller.project.list()).items).toHaveLength(5);
    const first = await caller.project.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1].id);
    const second = await caller.project.list({ limit: 2, cursor: first.nextCursor });
    const third = await caller.project.list({ limit: 2, cursor: second.nextCursor });
    const ids = [...first.items, ...second.items, ...third.items].map((p) => p.id);
    expect(new Set(ids).size).toBe(5);
    expect(third.nextCursor).toBeNull();
  });

  it("is scoped to the active organization", async () => {
    const user = await createUser();
    const team = await createOrg(user);
    await createProject(user, undefined, "personal");
    await createProject(user, team.id, "team");
    expect((await callerFor(user).project.list({})).items.map((p) => p.name)).toEqual(["personal"]);
    expect((await callerFor(user, team.id).project.list({})).items.map((p) => p.name)).toEqual(["team"]);
    const outsider = await createUser();
    await expect(callerFor(outsider, team.id).project.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("project CRUD", () => {
  it("creates in the active org with the creator recorded", async () => {
    const user = await createUser();
    const team = await createOrg(user);
    const created = await callerFor(user, team.id).project.create({ name: "  Onboarding  ", description: "Q3 interviews" });
    const row = await prisma.project.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ name: "Onboarding", description: "Q3 interviews", orgId: team.id, userId: user.id });
  });

  it("enforces the plan's project limit and role", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    await addMember(org.id, viewer, "VIEWER");
    await expect(callerFor(viewer, org.id).project.create({ name: "nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (let i = 0; i < PLAN_LIMITS.FREE.maxProjects; i++) await callerFor(owner, org.id).project.create({ name: `p${i}` });
    await expect(callerFor(owner, org.id).project.create({ name: "one too many" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("validates input sizes", async () => {
    const user = await createUser();
    await expect(callerFor(user).project.create({ name: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(user).project.create({ name: "x".repeat(121) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("renames, reports permissions and recent activity", async () => {
    const owner = await createUser();
    const member = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, member, "MEMBER");
    const project = await createProject(owner, org.id);
    await callerFor(member).project.update({ id: project.id, name: "Renamed", description: null });
    const detail = await callerFor(member).project.getById({ id: project.id });
    expect(detail).toMatchObject({ name: "Renamed", description: null, role: "MEMBER", permissions: { write: true, runAI: true, delete: false } });
    expect(detail.counts).toEqual({ documents: 0, readyDocuments: 0, processingDocuments: 0, failedDocuments: 0, syntheses: 0, recommendations: 0 });
    expect(detail.recent).toEqual({ documents: [], syntheses: [], recommendations: [] });
    expect(detail.latestReadySynthesis).toBeNull();
  });

  it("deletes the project, its rows and its stored objects (admin only)", async () => {
    const owner = await createUser();
    const member = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, member, "MEMBER");
    const project = await createProject(owner, org.id);
    const other = await createProject(owner, org.id, "other");
    await prisma.document.create({ data: { projectId: project.id, title: "d", type: "NOTE" } });
    await storage.put(`projects/${project.id}/documents/d1/a.txt`, Buffer.from("a"), "text/plain");
    await storage.put(`projects/${other.id}/documents/d2/b.txt`, Buffer.from("b"), "text/plain");

    await expect(callerFor(member).project.delete({ id: project.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const res = await callerFor(owner).project.delete({ id: project.id });
    expect(res).toEqual({ success: true, objectsDeleted: 1 });
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await prisma.document.count({ where: { projectId: project.id } })).toBe(0);
    expect([...storage.objects.keys()]).toEqual([`projects/${other.id}/documents/d2/b.txt`]);
  });
});
