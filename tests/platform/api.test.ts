import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { sha256Hex } from "@/lib/crypto";
import { QUEUE } from "@/server/jobs/queues";
import { validateApiKey } from "@/server/api/auth";
import { ROUTES } from "@/server/api/routes";
import { truncateIp } from "@/server/api/handler";
import { GET, POST, PATCH, DELETE } from "@/app/api/v1/[...path]/route";
import { jobsFor } from "../helpers/doubles";
import { callerFor } from "../helpers/caller";
import { createTenant, memberOf, type Tenant } from "./helpers";

const BASE = "https://beacon.test/api/v1";
const HANDLERS = { GET, POST, PATCH, DELETE } as const;

function call(method: keyof typeof HANDLERS, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return HANDLERS[method](req);
}

async function createKey(t: Tenant, scopes: string[], extra: { rateLimit?: number } = {}) {
  return callerFor(t.owner, t.orgId).apiKey.create({ name: "CI", scopes: scopes as never, ...extra });
}

let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  a = await createTenant("Acme");
  b = await createTenant("Globex");
});

describe("API key management", () => {
  it("stores only the SHA-256 hash, shows the key once and displays a prefix", async () => {
    const created = await createKey(a, ["projects:read"]);
    expect(created.key).toMatch(/^bk_live_[A-Za-z0-9_-]{43}$/);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.keyHash).toBe(sha256Hex(created.key));
    expect(row.prefix).toBe(created.key.slice(0, 12));
    expect(JSON.stringify(row)).not.toContain(created.key);
    const list = await callerFor(a.owner, a.orgId).apiKey.list();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.key);
    expect(list.items[0]).not.toHaveProperty("keyHash");
    expect(list.items[0].prefix).toBe(row.prefix);
  });

  it("requires OWNER/ADMIN, allowlisted scopes and a capped rate limit", async () => {
    const member = await memberOf(a.orgId, "MEMBER");
    const admin = await memberOf(a.orgId, "ADMIN");
    await expect(callerFor(member, a.orgId).apiKey.create({ name: "x", scopes: ["projects:read"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(admin, a.orgId).apiKey.create({ name: "x", scopes: ["projects:read"] })).resolves.toHaveProperty("key");
    await expect(callerFor(a.owner, a.orgId).apiKey.create({ name: "x", scopes: ["*"] as never })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(a.owner, a.orgId).apiKey.create({ name: "x", scopes: ["projects:read"], rateLimit: 5000 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // Org selection is explicit and membership-checked.
    await expect(callerFor(b.owner, a.orgId).apiKey.create({ name: "x", scopes: ["projects:read"] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Revoke is org-scoped.
    const key = await createKey(a, ["projects:read"]);
    await expect(callerFor(b.owner, b.orgId).apiKey.revoke({ id: key.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(member, a.orgId).apiKey.revoke({ id: key.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects revoked, expired and removed-member keys", async () => {
    const revoked = await createKey(a, ["projects:read"]);
    await callerFor(a.owner, a.orgId).apiKey.revoke({ id: revoked.id });
    expect(await validateApiKey(revoked.key)).toEqual({ valid: false, reason: "revoked" });

    const expired = await createKey(a, ["projects:read"]);
    await prisma.apiKey.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateApiKey(expired.key)).toEqual({ valid: false, reason: "expired" });

    const admin = await memberOf(a.orgId, "ADMIN");
    const leaverKey = await callerFor(admin, a.orgId).apiKey.create({ name: "leaver", scopes: ["projects:read"] });
    expect((await validateApiKey(leaverKey.key)).valid).toBe(true);
    await prisma.orgMember.delete({ where: { orgId_userId: { orgId: a.orgId, userId: admin.id } } });
    expect(await validateApiKey(leaverKey.key)).toEqual({ valid: false, reason: "creator_removed" });

    expect(await validateApiKey("bk_live_" + "x".repeat(43))).toEqual({ valid: false, reason: "unknown" });
    expect(await validateApiKey("bk_12345678")).toEqual({ valid: false, reason: "malformed" });

    const res = await call("GET", "/projects", revoked.key);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("aggregates usage for the org's keys", async () => {
    const key = await createKey(a, ["projects:read"]);
    await call("GET", "/projects", key.key);
    await call("GET", `/projects/${b.projectId}`, key.key);
    const usage = await callerFor(a.owner, a.orgId).apiKey.getUsage({ days: 7 });
    expect(usage.totals).toMatchObject({ requests: 2, errors: 1 });
    expect(usage.byEndpoint.map((e) => e.endpoint).sort()).toEqual(["/projects", "/projects/{projectId}"]);
    const other = await callerFor(b.owner, b.orgId).apiKey.getUsage({ days: 7 });
    expect(other.totals.requests).toBe(0);
    await expect(callerFor(b.owner, b.orgId).apiKey.getUsage({ keyId: key.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("REST API v1", () => {
  it("scopes every query to the key's org (cross-org IDOR returns 404)", async () => {
    const key = await createKey(a, ["projects:read", "documents:read", "synthesis:read", "recommendations:read", "voice:read"]);
    const list = await call("GET", "/projects", key.key);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: Array<{ id: string }>; nextCursor: string | null };
    expect(body.data.map((p) => p.id)).toEqual([a.projectId]);

    for (const path of [
      `/projects/${b.projectId}`,
      `/projects/${b.projectId}/documents`,
      `/projects/${b.projectId}/syntheses`,
      `/projects/${b.projectId}/recommendations`,
      `/projects/${b.projectId}/voice/insights`,
      `/voice/recordings?projectId=${b.projectId}`,
    ]) {
      const res = await call("GET", path, key.key);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "Project not found" } });
    }
    const foreignDoc = await prisma.document.create({ data: { projectId: b.projectId, title: "secret", type: "NOTE", status: "READY" } });
    expect((await call("GET", `/projects/${a.projectId}/documents/${foreignDoc.id}`, key.key)).status).toBe(404);
    const foreignRecording = await prisma.voiceRecording.create({
      data: { projectId: b.projectId, userId: b.owner.id, duration: 10, audioKey: "k", recordedAt: new Date(), status: "READY" },
    });
    expect((await call("GET", `/voice/recordings/${foreignRecording.id}`, key.key)).status).toBe(404);
  });

  it("enforces scopes per route", async () => {
    const key = await createKey(a, ["documents:read"]);
    const res = await call("GET", "/projects", key.key);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "INSUFFICIENT_SCOPE" } });
    expect((await call("POST", `/projects/${a.projectId}/documents`, key.key, { title: "t", text: "x" })).status).toBe(403);
    expect((await call("GET", `/projects/${a.projectId}/documents`, key.key)).status).toBe(200);
  });

  it("rate limits per key with 429 and Retry-After", async () => {
    const key = await createKey(a, ["projects:read"], { rateLimit: 2 });
    expect((await call("GET", "/projects", key.key)).status).toBe(200);
    expect((await call("GET", "/projects", key.key)).status).toBe(200);
    const limited = await call("GET", "/projects", key.key);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("validates and size-caps JSON input with generic error bodies", async () => {
    const key = await createKey(a, ["projects:write", "documents:write", "synthesis:write"]);
    const bad = await call("POST", "/projects", key.key, { name: "", orgId: b.orgId });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { details: Array<{ path: string }> } };
    expect(badBody.error.details.length).toBeGreaterThan(0);
    const huge = await call("POST", `/projects/${a.projectId}/documents`, key.key, { title: "t", text: "x".repeat(1_200_000) });
    expect(huge.status).toBe(413);
    const notJson = await HANDLERS.POST(
      new Request(`${BASE}/projects`, { method: "POST", headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" }, body: "{" })
    );
    expect(notJson.status).toBe(400);
    expect((await call("GET", "/nope", key.key)).status).toBe(404);
    const wrongMethod = await call("DELETE", "/projects", key.key);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("GET");
    expect((await call("GET", "/projects", null)).status).toBe(401);
  });

  it("creates documents and syntheses inside the key's org only", async () => {
    const key = await createKey(a, ["projects:write", "documents:write", "documents:read", "synthesis:write"]);
    const created = await call("POST", "/projects", key.key, { name: "From API" });
    expect(created.status).toBe(201);
    const project = ((await created.json()) as { data: { id: string } }).data;
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).orgId).toBe(a.orgId);

    const doc = await call("POST", `/projects/${project.id}/documents`, key.key, { title: "Call notes", text: "Customers want SSO." });
    expect(doc.status).toBe(202);
    const docBody = (await doc.json()) as { data: { id: string; status: string } };
    expect(docBody.data.status).toBe("PENDING");
    expect(jobsFor(QUEUE.DOCUMENTS)).toHaveLength(1);
    // The shape tests/load/ingest.js polls: several statuses, comma-separated.
    const pending = await call("GET", `/projects/${project.id}/documents?status=PROCESSING,PENDING&limit=1`, key.key);
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { data: Array<{ id: string }> }).data.map((d) => d.id)).toEqual([docBody.data.id]);
    expect((await call("GET", `/projects/${project.id}/documents?status=PENDING,BOGUS`, key.key)).status).toBe(400);
    const detail = await call("GET", `/projects/${project.id}/documents/${docBody.data.id}`, key.key);
    expect(((await detail.json()) as { data: { characterCount: number } }).data.characterCount).toBe("Customers want SSO.".length);

    const noDocs = await call("POST", `/projects/${project.id}/syntheses`, key.key, {});
    expect(noDocs.status).toBe(422);
    await prisma.document.update({ where: { id: docBody.data.id }, data: { status: "READY" } });
    const started = await call("POST", `/projects/${project.id}/syntheses`, key.key, { type: "THEMES" });
    expect(started.status).toBe(202);
    expect(jobsFor(QUEUE.SYNTHESIS)).toHaveLength(1);
    expect((await call("POST", `/projects/${project.id}/syntheses`, key.key, {})).status).toBe(409);
    expect((await call("POST", `/projects/${b.projectId}/documents`, key.key, { title: "x", text: "y" })).status).toBe(404);
  });

  it("records ApiUsage per request with the route template and a truncated IP", async () => {
    const key = await createKey(a, ["projects:read"]);
    await call("GET", `/projects/${a.projectId}`, key.key, undefined, { "x-forwarded-for": "203.0.113.77, 10.0.0.1", "user-agent": "ci" });
    const rows = await prisma.apiUsage.findMany({ where: { apiKeyId: key.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ endpoint: "/projects/{projectId}", method: "GET", statusCode: 200, ipAddress: "203.0.113.0", userAgent: "ci" });
    expect(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::/48");
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedAt).not.toBeNull();
  });
});

describe("OpenAPI document", () => {
  it("is served without auth and covers every route definition", async () => {
    const res = await call("GET", "/openapi.json", null);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; "x-required-scope": string; responses: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    for (const route of ROUTES) {
      const op = doc.paths[route.path]?.[route.method.toLowerCase()];
      expect(op, `${route.method} ${route.path}`).toBeDefined();
      expect(op.operationId).toBe(route.operationId);
      expect(op["x-required-scope"]).toBe(route.scope);
      expect(op.responses[String(route.status ?? 200)]).toBeDefined();
    }
    const opCount = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
    expect(opCount).toBe(ROUTES.length);
    expect(doc.components.schemas).toHaveProperty("Project");
    expect(doc.components.schemas).toHaveProperty("Error");
    expect(JSON.stringify(doc)).not.toContain("#/$defs/");
  });
});
