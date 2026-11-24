import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { can, requireOrgPermission, requireProjectAccess, ROLE_PERMISSIONS } from "@/server/auth/access";
import { assertCanCreate, assertTokenBudget, BudgetExceededError, PLAN_LIMITS, recordTokenUsage } from "@/server/usage/entitlements";
import { createTestContext } from "@/server/context";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";

const ctxFor = (userId: string | null) => createTestContext({ user: userId ? { id: userId, clerkId: "c", email: null, name: null } : null });

describe("permission matrix", () => {
  it("grants owners everything and viewers read-only", () => {
    for (const perm of ROLE_PERMISSIONS.ADMIN) expect(can("OWNER", perm)).toBe(true);
    expect(can("OWNER", "owners:manage")).toBe(true);
    expect(can("ADMIN", "owners:manage")).toBe(false);
    expect(can("MEMBER", "members:manage")).toBe(false);
    expect(can("MEMBER", "ai:run")).toBe(true);
    expect(can("VIEWER", "project:read")).toBe(true);
    expect(can("VIEWER", "project:write")).toBe(false);
    expect(can("VIEWER", "ai:run")).toBe(false);
  });
});

describe("requireProjectAccess", () => {
  it("allows org members per role and hides projects from outsiders", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const outsider = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, viewer, "VIEWER");
    const project = await createProject(owner, org.id);

    await expect(requireProjectAccess(ctxFor(owner.id), project.id, "project:delete")).resolves.toMatchObject({ id: project.id, role: "OWNER" });
    await expect(requireProjectAccess(ctxFor(viewer.id), project.id, "project:read")).resolves.toMatchObject({ role: "VIEWER" });
    await expect(requireProjectAccess(ctxFor(viewer.id), project.id, "project:write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requireProjectAccess(ctxFor(outsider.id), project.id, "project:read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requireProjectAccess(ctxFor(null), project.id, "project:read")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(requireProjectAccess(ctxFor(owner.id), "nonexistent", "project:read")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("treats un-accepted invitations (no joinedAt) as non-membership", async () => {
    const owner = await createUser();
    const invitee = await createUser();
    const org = await createOrg(owner);
    await prisma.orgMember.create({ data: { orgId: org.id, userId: invitee.id, role: "MEMBER" } });
    await expect(requireOrgPermission(ctxFor(invitee.id), org.id, "org:read")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("entitlements", () => {
  it("enforces per-plan resource limits", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    for (let i = 0; i < PLAN_LIMITS.FREE.maxProjects; i++) await createProject(owner, org.id, `p${i}`);
    await expect(assertCanCreate(org.id, "projects")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks LLM work once the monthly token budget is spent", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    await expect(assertTokenBudget(org.id)).resolves.toBeUndefined();
    await recordTokenUsage({
      orgId: org.id,
      feature: "test",
      provider: "anthropic",
      model: "m",
      inputTokens: PLAN_LIMITS.FREE.monthlyTokens,
      outputTokens: 1,
    });
    // Clear the cache key so the aggregate is recomputed.
    const { getRedis } = await import("@/lib/redis");
    const keys = await getRedis().keys(`usage:tokens:${org.id}:*`);
    if (keys.length) await getRedis().del(...keys);
    await expect(assertTokenBudget(org.id)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("does not count disconnected integrations toward the plan limit", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    const providers = ["SLACK", "JIRA", "LINEAR"] as const;
    // FREE allows 2: two disconnected rows + one connected must still allow another.
    await prisma.integration.create({ data: { orgId: org.id, userId: owner.id, provider: providers[0], status: "DISCONNECTED" } });
    await prisma.integration.create({ data: { orgId: org.id, userId: owner.id, provider: providers[1], status: "DISCONNECTED" } });
    await prisma.integration.create({ data: { orgId: org.id, userId: owner.id, provider: providers[2], status: "CONNECTED" } });
    await expect(assertCanCreate(org.id, "integrations")).resolves.toBeUndefined();
    await prisma.integration.create({ data: { orgId: org.id, userId: owner.id, provider: "NOTION", status: "CONNECTED" } });
    await expect(assertCanCreate(org.id, "integrations")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not count Deepgram audio seconds toward the token budget", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    await recordTokenUsage({
      orgId: org.id,
      feature: "voice.transcribe",
      provider: "deepgram",
      model: "nova-3",
      inputTokens: PLAN_LIMITS.FREE.monthlyTokens * 2,
      outputTokens: 0,
    });
    await expect(assertTokenBudget(org.id)).resolves.toBeUndefined();
  });
});
