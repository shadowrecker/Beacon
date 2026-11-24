import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST } from "@/app/api/admin/orgs/[orgId]/plan/route";
import { createOrg, createUser } from "../helpers/factories";

const TOKEN = "admin-token-for-tests-0123456789abcdef";

function call(orgId: string, body: unknown, auth?: string) {
  const req = new Request(`http://localhost:3000/api/admin/orgs/${orgId}/plan`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ orgId }) });
}

describe("POST /api/admin/orgs/:orgId/plan", () => {
  afterEach(() => {
    delete process.env.ADMIN_API_TOKEN;
  });

  it("does not exist unless ADMIN_API_TOKEN is configured", async () => {
    delete process.env.ADMIN_API_TOKEN;
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    expect((await call(org.id, { plan: "ENTERPRISE" }, `Bearer ${TOKEN}`)).status).toBe(404);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).plan).toBe("FREE");
  });

  it("requires the exact bearer token", async () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    expect((await call(org.id, { plan: "ENTERPRISE" })).status).toBe(401);
    expect((await call(org.id, { plan: "ENTERPRISE" }, `Bearer ${TOKEN}x`)).status).toBe(401);
    expect((await call(org.id, { plan: "ENTERPRISE" }, TOKEN)).status).toBe(401);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).plan).toBe("FREE");
  });

  it("changes the plan with a valid token and validates input", async () => {
    process.env.ADMIN_API_TOKEN = TOKEN;
    const owner = await createUser();
    const org = await createOrg(owner, { plan: "FREE" });
    const res = await call(org.id, { plan: "ENTERPRISE" }, `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: org.id, plan: "ENTERPRISE", previousPlan: "FREE" });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).plan).toBe("ENTERPRISE");

    expect((await call(org.id, { plan: "PLATINUM" }, `Bearer ${TOKEN}`)).status).toBe(400);
    expect((await call(org.id, "not json", `Bearer ${TOKEN}`)).status).toBe(400);
    expect((await call("doesnotexist0000", { plan: "TEAM" }, `Bearer ${TOKEN}`)).status).toBe(404);
  });
});
