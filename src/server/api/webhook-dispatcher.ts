/**
 * Outbound webhooks: URL validation, signing, fan-out and delivery.
 *
 * - URLs must be https and may not name localhost, *.internal/*.local hosts or a
 *   literal private/loopback/link-local/metadata address. DNS-level checks happen
 *   at delivery time inside safeFetch (validated at connect time, so DNS rebinding
 *   can't bypass it). Redirects are not followed: a 3xx is a failed delivery.
 * - Each delivery is signed: `x-beacon-signature: sha256=<hex HMAC-SHA256(secret,
 *   "<timestamp>.<body>")>` with `x-beacon-timestamp` in Unix seconds, so receivers
 *   can verify integrity and reject replays.
 * - Non-2xx responses throw, so BullMQ retries (6 attempts, exponential backoff).
 *   A delivery that exhausts its attempts counts as one consecutive failure; after
 *   AUTO_DISABLE_THRESHOLD consecutive failed deliveries the webhook is disabled
 *   and the org's admins are notified. Any success resets the counter.
 */
import { isIP } from "node:net";
import type { DomainEvent, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptString, encryptString, hmacSha256Hex, randomToken } from "@/lib/crypto";
import { isBlockedAddress, safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import type { Logger } from "@/lib/logger";
import { WEBHOOK_EVENTS } from "../events/catalog";
import { enqueue, QUEUE } from "../jobs/queues";
import { NonRetryableError, type JobContext } from "../jobs/worker";
import { notify } from "../notifications/notify";

export const AUTO_DISABLE_THRESHOLD = 20;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const TEST_EVENT = "webhook.test";
const RESPONSE_EXCERPT = 256;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

// ---------------------------------------------------------------------------
// Validation and secrets
// ---------------------------------------------------------------------------

/** Returns a problem description, or null when the URL is acceptable. */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a valid URL";
  }
  if (url.protocol !== "https:") return "Webhook URLs must use https://";
  if (url.username || url.password) return "Webhook URLs may not contain credentials";
  if (url.port && url.port !== "443" && !/^\d{2,5}$/.test(url.port)) return "Invalid port";
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "Enter a valid URL";
  if (isIP(host)) {
    if (isBlockedAddress(host)) return "Webhook URLs may not point to private, loopback or link-local addresses";
    return null;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".lan")) {
    return "Webhook URLs must point to a public host";
  }
  if (!host.includes(".")) return "Webhook URLs must use a fully qualified public hostname";
  return null;
}

export function generateWebhookSecret(): string {
  return `whsec_${randomToken(32)}`;
}

export function encryptWebhookSecret(secret: string): string {
  return encryptString(secret).envelope;
}

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `sha256=${hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? u.pathname.slice(0, 60) : ""}`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Delivery state
// ---------------------------------------------------------------------------

export type DeliveryStatus = "pending" | "retrying" | "delivered" | "failed";

/**
 * Derived status. `deliveredAt` is the time the delivery reached a terminal state
 * (delivered or finally failed); `attemptCount` counts attempts made.
 */
export function deliveryStatus(d: { success: boolean; deliveredAt: Date | null; attemptCount: number }): DeliveryStatus {
  if (d.success) return "delivered";
  if (d.deliveredAt) return "failed";
  return d.attemptCount === 0 ? "pending" : "retrying";
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** At most 256 printable characters of the receiver's response. */
export function sanitizeExcerpt(text: string): string {
  const clean = text.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  return clean.length > RESPONSE_EXCERPT ? clean.slice(0, RESPONSE_EXCERPT) : clean;
}

// ---------------------------------------------------------------------------
// Fan-out (domain event -> delivery rows)
// ---------------------------------------------------------------------------

export function buildEnvelope(event: Pick<DomainEvent, "id" | "type" | "orgId" | "projectId" | "createdAt" | "payload">) {
  return {
    id: event.id,
    type: event.type,
    createdAt: event.createdAt.toISOString(),
    organizationId: event.orgId,
    projectId: event.projectId,
    data: event.payload,
  };
}

/** Create one delivery per subscribed, active webhook. Idempotent per (webhook, event id). */
export async function fanOutEvent(event: DomainEvent, log: Logger): Promise<number> {
  if (!(WEBHOOK_EVENTS as string[]).includes(event.type)) return 0;
  const hooks = await prisma.webhook.findMany({
    where: { orgId: event.orgId, active: true, disabledAt: null, events: { has: event.type } },
    select: { id: true },
    take: 500,
  });
  let created = 0;
  for (const hook of hooks) {
    const existing = await prisma.webhookDelivery.findFirst({
      where: { webhookId: hook.id, payload: { path: ["id"], equals: event.id } },
      select: { id: true, success: true, deliveredAt: true },
    });
    let deliveryId = existing?.id;
    if (!existing) {
      const row = await prisma.webhookDelivery.create({
        data: {
          webhookId: hook.id,
          event: event.type,
          payload: buildEnvelope(event) as unknown as Prisma.InputJsonValue,
          attemptCount: 0,
          success: false,
        },
        select: { id: true },
      });
      deliveryId = row.id;
      created++;
    } else if (existing.success || existing.deliveredAt) {
      continue; // already terminal; nothing to (re)enqueue
    }
    await enqueue(QUEUE.WEBHOOKS, { deliveryId: deliveryId! }, { jobId: `whd_${deliveryId}` });
  }
  if (created) log.info("webhook deliveries queued", { eventId: event.id, type: event.type, created });
  return created;
}

/** Queue a synthetic `webhook.test` delivery. */
export async function queueTestDelivery(webhook: { id: string; orgId: string }, actorUserId: string): Promise<string> {
  const now = new Date();
  const id = `test_${randomToken(12)}`;
  const row = await prisma.webhookDelivery.create({
    data: {
      webhookId: webhook.id,
      event: TEST_EVENT,
      payload: {
        id,
        type: TEST_EVENT,
        createdAt: now.toISOString(),
        organizationId: webhook.orgId,
        projectId: null,
        data: { message: "This is a test delivery from Beacon.", triggeredBy: actorUserId },
      },
      attemptCount: 0,
      success: false,
    },
    select: { id: true },
  });
  await enqueue(QUEUE.WEBHOOKS, { deliveryId: row.id }, { jobId: `whd_${row.id}` });
  return row.id;
}

// ---------------------------------------------------------------------------
// Delivery (worker)
// ---------------------------------------------------------------------------

class DeliveryFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryFailedError";
  }
}

async function recordFailure(webhookId: string, final: boolean, log: Logger): Promise<void> {
  const updated = await prisma.webhook.update({
    where: { id: webhookId },
    data: { failureCount: { increment: 1 }, ...(final ? { consecutiveFailures: { increment: 1 } } : {}) },
    select: { id: true, orgId: true, name: true, consecutiveFailures: true, active: true },
  });
  if (!final || !updated.active || updated.consecutiveFailures < AUTO_DISABLE_THRESHOLD) return;
  const disabled = await prisma.webhook.updateMany({
    where: { id: webhookId, active: true },
    data: { active: false, disabledAt: new Date() },
  });
  if (disabled.count === 0) return;
  log.warn("webhook auto-disabled", { webhookId, consecutiveFailures: updated.consecutiveFailures });
  const admins = await prisma.orgMember.findMany({
    where: { orgId: updated.orgId, joinedAt: { not: null }, role: { in: ["OWNER", "ADMIN"] } },
    select: { userId: true },
  });
  await notify({
    userIds: admins.map((a) => a.userId),
    type: "SYSTEM",
    title: `Webhook "${updated.name.slice(0, 80)}" was disabled`,
    message: `Beacon disabled this webhook after ${AUTO_DISABLE_THRESHOLD} consecutive failed deliveries. Fix the endpoint, then re-enable it under Developer > Webhooks.`,
    resourceType: "webhook",
    resourceId: updated.id,
    href: "/developer/webhooks",
    dedupeKey: `webhook_disabled_${updated.id}_${Date.now()}`,
  });
}

export interface DeliveryResult {
  deliveryId: string;
  status: DeliveryStatus | "skipped";
  statusCode?: number;
}

export async function deliverWebhook(deliveryId: string, job: Pick<JobContext, "attempt" | "maxAttempts" | "log">): Promise<DeliveryResult> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true,
      event: true,
      payload: true,
      success: true,
      deliveredAt: true,
      webhook: { select: { id: true, url: true, secretEncrypted: true, active: true, disabledAt: true } },
    },
  });
  if (!delivery) return { deliveryId, status: "skipped" };
  if (delivery.success || delivery.deliveredAt) return { deliveryId, status: deliveryStatus({ ...delivery, attemptCount: 1 }) };

  const hook = delivery.webhook;
  const isTest = delivery.event === TEST_EVENT;
  if ((!hook.active || hook.disabledAt) && !isTest) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { deliveredAt: new Date(), responseBody: "Not sent: the webhook is disabled" },
    });
    return { deliveryId, status: "failed" };
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = decryptString(hook.secretEncrypted);
  const headers = {
    "content-type": "application/json",
    "user-agent": "Beacon-Webhooks/1.0",
    "x-beacon-event": delivery.event,
    "x-beacon-delivery": delivery.id,
    "x-beacon-timestamp": String(timestamp),
    "x-beacon-signature": signPayload(secret, timestamp, body),
  };

  const started = Date.now();
  let statusCode: number | null = null;
  let excerpt: string | null = null;
  let failure: Error | null = null;
  try {
    const res = await safeFetch(hook.url, {
      method: "POST",
      headers,
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      maxRedirects: 0,
    });
    statusCode = res.status;
    excerpt = sanitizeExcerpt(res.text());
    if (!res.ok) failure = new DeliveryFailedError(`Receiver responded with status ${res.status}`);
  } catch (err) {
    if (err instanceof SafeFetchError) {
      excerpt = err.code === "TOO_MANY_REDIRECTS" ? "Redirects are not followed" : err.message;
      failure =
        err.code === "BLOCKED_ADDRESS" || err.code === "BLOCKED_PROTOCOL" || err.code === "INVALID_URL"
          ? new NonRetryableError(`Delivery blocked: ${err.message}`)
          : new DeliveryFailedError(err.message);
    } else {
      failure = new DeliveryFailedError("Delivery failed");
      job.log.warn("webhook delivery error", { deliveryId, err });
    }
  }
  const durationMs = Date.now() - started;
  const success = failure === null;
  const final = success || failure instanceof NonRetryableError || job.attempt >= job.maxAttempts;

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      attemptCount: { increment: 1 },
      statusCode,
      durationMs,
      responseBody: excerpt,
      success,
      ...(final ? { deliveredAt: new Date() } : {}),
    },
  });

  if (success) {
    if (!isTest) {
      await prisma.webhook.update({ where: { id: hook.id }, data: { consecutiveFailures: 0, lastTriggeredAt: new Date() } });
    }
    return { deliveryId, status: "delivered", statusCode: statusCode ?? undefined };
  }
  if (!isTest) await recordFailure(hook.id, final, job.log);
  // Throw so BullMQ retries (or, when non-retryable, stops immediately).
  throw failure!;
}

/** Final-failure hook: make sure the delivery is marked terminal. */
export async function markDeliveryFailed(deliveryId: string): Promise<void> {
  await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, success: false, deliveredAt: null },
    data: { deliveredAt: new Date() },
  });
}
