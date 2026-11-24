import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { UnrecoverableError } from "bullmq";
import { prisma } from "@/lib/db";
import { decryptString, hmacSha256Hex } from "@/lib/crypto";
import { QUEUE } from "@/server/jobs/queues";
import { runJob } from "@/server/jobs/worker";
import { webhooksSubscriber } from "@/server/events/subscribers/webhooks";
import { AUTO_DISABLE_THRESHOLD, encryptWebhookSecret, webhookUrlProblem } from "@/server/api/webhook-dispatcher";
import { webhookWorker } from "@/workers/webhook-worker";
import { verifyWebhookSignature } from "../../packages/sdk/src/index";
import { jobsFor } from "../helpers/doubles";
import { callerFor } from "../helpers/caller";
import { createTenant, insertEvent, jobMeta, log, memberOf, type Tenant } from "./helpers";

// Allow safeFetch to reach the local test receiver; every other guard stays real.
const receiver = vi.hoisted(() => ({ origin: "" }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (url: string, opts: Parameters<typeof actual.safeFetch>[1] = {}) =>
      actual.safeFetch(url, { ...opts, unsafeTestAllowOrigins: [receiver.origin] }),
  };
});

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];
let respondWith = 200;
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(respondWith, { "content-type": "text/plain", ...(respondWith === 302 ? { location: `${receiver.origin}/elsewhere` } : {}) });
      res.end(respondWith >= 400 ? `boom\u0000 ${"x".repeat(1000)}` : "ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiver.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  received.length = 0;
  respondWith = 200;
  a = await createTenant("Acme");
  b = await createTenant("Globex");
});

/** A webhook pointing at the local receiver (inserted directly: the router only accepts public https URLs). */
async function localHook(t: Tenant, events: string[], secret = "whsec_test_secret") {
  return prisma.webhook.create({
    data: { orgId: t.orgId, name: "Local", url: `${receiver.origin}/hook`, events, secretEncrypted: encryptWebhookSecret(secret), createdBy: t.owner.id },
  });
}

describe("webhook management", () => {
  it.each([
    "http://example.com/hook",
    "https://127.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.5:8443/x",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://localhost/x",
    "https://metadata.google.internal/x",
    "https://user:pass@example.com/x",
    "gopher://example.com",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", async (url) => {
    await expect(callerFor(a.owner, a.orgId).webhook.create({ name: "x", url, events: ["synthesis.completed"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("accepts public https URLs and only WEBHOOK_EVENTS", async () => {
    expect(webhookUrlProblem("https://hooks.example.com/beacon?x=1")).toBeNull();
    await expect(
      callerFor(a.owner, a.orgId).webhook.create({ name: "x", url: "https://hooks.example.com/b", events: ["member.joined" as never] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("encrypts the secret at rest, shows it once, and rotates it", async () => {
    const created = await callerFor(a.owner, a.orgId).webhook.create({ name: "Prod", url: "https://hooks.example.com/b", events: ["synthesis.completed"] });
    expect(created.secret).toMatch(/^whsec_/);
    const row = await prisma.webhook.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.secretEncrypted).not.toContain(created.secret);
    expect(decryptString(row.secretEncrypted)).toBe(created.secret);
    const list = await callerFor(a.owner, a.orgId).webhook.list();
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(list.items[0]).not.toHaveProperty("secretEncrypted");

    const rotated = await callerFor(a.owner, a.orgId).webhook.rotateSecret({ id: created.id });
    expect(rotated.secret).not.toBe(created.secret);
    expect(decryptString((await prisma.webhook.findUniqueOrThrow({ where: { id: created.id } })).secretEncrypted)).toBe(rotated.secret);
  });

  it("requires webhooks:manage for writes and scopes everything to the org", async () => {
    const member = await memberOf(a.orgId, "MEMBER");
    await expect(
      callerFor(member, a.orgId).webhook.create({ name: "x", url: "https://hooks.example.com/b", events: ["synthesis.completed"] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const hook = await callerFor(a.owner, a.orgId).webhook.create({ name: "x", url: "https://hooks.example.com/b?token=s3cret", events: ["synthesis.completed"] });
    const memberView = await callerFor(member, a.orgId).webhook.list();
    expect(memberView.items[0].url).toBe("https://hooks.example.com/b");
    await expect(callerFor(member, a.orgId).webhook.test({ id: hook.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(b.owner, b.orgId).webhook.test({ id: hook.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.owner, b.orgId).webhook.getDeliveries({ webhookId: hook.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.owner, b.orgId).webhook.delete({ id: hook.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(a.owner, a.orgId).webhook.update({ id: hook.id, url: "https://192.168.1.1/x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const { deliveryId } = await callerFor(a.owner, a.orgId).webhook.test({ id: hook.id });
    expect(jobsFor(QUEUE.WEBHOOKS).map((j) => j.payload)).toEqual([{ deliveryId }]);
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.event).toBe("webhook.test");
  });
});

describe("webhook fan-out", () => {
  it("creates one delivery per subscribed active webhook of the event's org, idempotently", async () => {
    const subscribed = await localHook(a, ["synthesis.completed"]);
    await localHook(a, ["document.ready"]);
    const disabled = await localHook(a, ["synthesis.completed"]);
    await prisma.webhook.update({ where: { id: disabled.id }, data: { active: false, disabledAt: new Date() } });
    await localHook(b, ["synthesis.completed"]);

    const event = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "synthesis.completed", { synthesisId: "s1", themeCount: 4 });
    expect(webhooksSubscriber.handles("synthesis.completed")).toBe(true);
    expect(webhooksSubscriber.handles("member.joined")).toBe(false);
    await webhooksSubscriber.handle(event, log);
    await webhooksSubscriber.handle(event, log);
    const deliveries = await prisma.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ webhookId: subscribed.id, event: "synthesis.completed" });
    expect((deliveries[0].payload as { id: string; data: { themeCount: number } }).id).toBe(event.id);
    expect(jobsFor(QUEUE.WEBHOOKS)).toHaveLength(1);
  });
});

describe("webhook delivery", () => {
  async function deliveryFor(t: Tenant, secret = "whsec_test_secret") {
    const hook = await localHook(t, ["synthesis.completed"], secret);
    const event = await insertEvent({ orgId: t.orgId, projectId: t.projectId }, "synthesis.completed", { synthesisId: "s1", themeCount: 2 });
    await webhooksSubscriber.handle(event, log);
    const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { webhookId: hook.id } });
    return { hook, delivery };
  }

  it("signs timestamp.body so receivers can verify it", async () => {
    const { hook, delivery } = await deliveryFor(a, "whsec_verify_me");
    await runJob(webhookWorker, { deliveryId: delivery.id }, jobMeta(1, 6));
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers["x-beacon-event"]).toBe("synthesis.completed");
    expect(headers["x-beacon-delivery"]).toBe(delivery.id);
    const ts = String(headers["x-beacon-timestamp"]);
    expect(headers["x-beacon-signature"]).toBe(`sha256=${hmacSha256Hex("whsec_verify_me", `${ts}.${body}`)}`);
    await expect(
      verifyWebhookSignature({ payload: body, signature: String(headers["x-beacon-signature"]), timestamp: ts, secret: "whsec_verify_me" })
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({ payload: body + " ", signature: String(headers["x-beacon-signature"]), timestamp: ts, secret: "whsec_verify_me" })
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({ payload: body, signature: String(headers["x-beacon-signature"]), timestamp: ts, secret: "whsec_verify_me", now: Number(ts) + 3600 })
    ).resolves.toBe(false);
    expect(JSON.parse(body)).toMatchObject({ type: "synthesis.completed", data: { synthesisId: "s1", themeCount: 2 } });

    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row).toMatchObject({ success: true, statusCode: 200, attemptCount: 1 });
    expect(row.deliveredAt).not.toBeNull();
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: hook.id } })).lastTriggeredAt).not.toBeNull();
    // A redelivered job does not POST again.
    await runJob(webhookWorker, { deliveryId: delivery.id }, jobMeta(1, 6));
    expect(received).toHaveLength(1);
  });

  it("throws on non-2xx so BullMQ retries, and records a sanitized excerpt", async () => {
    respondWith = 500;
    const { hook, delivery } = await deliveryFor(a);
    await expect(runJob(webhookWorker, { deliveryId: delivery.id }, jobMeta(1, 6))).rejects.toThrow(/status 500/);
    let row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row).toMatchObject({ success: false, statusCode: 500, attemptCount: 1, deliveredAt: null });
    expect(row.responseBody!.length).toBeLessThanOrEqual(256);
    expect(row.responseBody).not.toContain("\u0000");
    // Not final yet: the consecutive-failure counter only moves when a delivery gives up.
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: hook.id } })).consecutiveFailures).toBe(0);

    respondWith = 204;
    await runJob(webhookWorker, { deliveryId: delivery.id }, jobMeta(2, 6));
    row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row).toMatchObject({ success: true, statusCode: 204, attemptCount: 2 });

    const history = await callerFor(a.owner, a.orgId).webhook.getDeliveries({ webhookId: hook.id });
    expect(history.items[0]).toMatchObject({ status: "delivered", attemptCount: 2 });
    expect(history.items[0]).not.toHaveProperty("payload");
  });

  it("auto-disables after consecutive failed deliveries and notifies admins", async () => {
    respondWith = 503;
    const admin = await memberOf(a.orgId, "ADMIN");
    const member = await memberOf(a.orgId, "MEMBER");
    const { hook, delivery } = await deliveryFor(a);
    await prisma.webhook.update({ where: { id: hook.id }, data: { consecutiveFailures: AUTO_DISABLE_THRESHOLD - 1 } });
    // Final attempt fails.
    await expect(runJob(webhookWorker, { deliveryId: delivery.id }, jobMeta(6, 6))).rejects.toThrow();
    const after = await prisma.webhook.findUniqueOrThrow({ where: { id: hook.id } });
    expect(after.active).toBe(false);
    expect(after.disabledAt).not.toBeNull();
    expect(after.consecutiveFailures).toBe(AUTO_DISABLE_THRESHOLD);
    const notified = (await prisma.notification.findMany({ select: { userId: true } })).map((n) => n.userId).sort();
    expect(notified).toEqual([a.owner.id, admin.id].sort());
    expect(notified).not.toContain(member.id);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).deliveredAt).not.toBeNull();

    // New events no longer fan out to the disabled webhook; re-enabling resets the counter.
    const e2 = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "synthesis.completed", { synthesisId: "s2", themeCount: 1 });
    await webhooksSubscriber.handle(e2, log);
    expect(await prisma.webhookDelivery.count()).toBe(1);
    await callerFor(a.owner, a.orgId).webhook.update({ id: hook.id, active: true });
    expect(await prisma.webhook.findUniqueOrThrow({ where: { id: hook.id } })).toMatchObject({ active: true, disabledAt: null, consecutiveFailures: 0 });
  });

  it("never follows redirects and refuses blocked destinations without retrying", async () => {
    respondWith = 302;
    const { delivery: redirected } = await deliveryFor(a);
    await expect(runJob(webhookWorker, { deliveryId: redirected.id }, jobMeta(1, 6))).rejects.toThrow();
    expect(received).toHaveLength(1);
    const redirectRow = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: redirected.id } });
    expect(redirectRow).toMatchObject({ success: false, responseBody: "Redirects are not followed" });

    const hook = await prisma.webhook.create({
      data: { orgId: a.orgId, name: "Bad", url: "https://169.254.169.254/x", events: ["synthesis.completed"], secretEncrypted: encryptWebhookSecret("s"), createdBy: a.owner.id },
    });
    const delivery = await prisma.webhookDelivery.create({ data: { webhookId: hook.id, event: "synthesis.completed", payload: { id: "e" }, attemptCount: 0 } });
    await expect(runJob(webhookWorker, { deliveryId: delivery.id }, jobMeta(1, 6))).rejects.toBeInstanceOf(UnrecoverableError);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.success).toBe(false);
    expect(row.deliveredAt).not.toBeNull();
  });
});
