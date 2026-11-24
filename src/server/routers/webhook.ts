/**
 * Webhook management. Webhooks belong to an org; writes require
 * webhooks:manage (OWNER/ADMIN). The signing secret is generated server-side,
 * stored encrypted, and returned only from create and rotateSecret. Lists never
 * include secrets; members without manage rights see a masked URL.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, orgProcedure, outboundProcedure } from "../trpc";
import { can, found, requireOrgPermission } from "../auth/access";
import { assertCanCreate } from "../usage/entitlements";
import { WEBHOOK_EVENTS, type EventType } from "../events/catalog";
import {
  deliveryStatus,
  encryptWebhookSecret,
  generateWebhookSecret,
  maskUrl,
  queueTestDelivery,
  sanitizeExcerpt,
  webhookUrlProblem,
} from "../api/webhook-dispatcher";

const id = z.string().min(1).max(64);
const orgId = id.optional();
const name = z.string().trim().min(1, "Name is required").max(100, "Name must be at most 100 characters");
/** Checked by assertUrl (https only, no private/loopback/metadata hosts) for a clear error message. */
const url = z.string().trim().min(1, "URL is required").max(2000, "URL is too long");
const events = z
  .array(z.enum(WEBHOOK_EVENTS as [EventType, ...EventType[]]))
  .min(1, "Choose at least one event")
  .max(WEBHOOK_EVENTS.length)
  .transform((e) => [...new Set(e)]);

function assertUrl(u: string): void {
  const problem = webhookUrlProblem(u);
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
}

export const webhookRouter = router({
  list: orgProcedure
    .input(z.object({ orgId, limit: z.number().int().min(1).max(100).default(50), cursor: id.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 50;
      const canManage = can(ctx.org.role, "webhooks:manage");
      const rows = await ctx.prisma.webhook.findMany({
        where: { orgId: ctx.org.orgId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          url: true,
          events: true,
          active: true,
          disabledAt: true,
          consecutiveFailures: true,
          failureCount: true,
          lastTriggeredAt: true,
          createdAt: true,
          deliveries: {
            take: 1,
            orderBy: { createdAt: "desc" },
            select: { success: true, deliveredAt: true, attemptCount: true, createdAt: true, statusCode: true },
          },
        },
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map(({ deliveries, url: rawUrl, ...w }) => ({
          ...w,
          url: canManage ? rawUrl : maskUrl(rawUrl),
          lastDelivery: deliveries[0]
            ? { status: deliveryStatus(deliveries[0]), statusCode: deliveries[0].statusCode, createdAt: deliveries[0].createdAt }
            : null,
        })),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        canManage,
      };
    }),

  /** Create a webhook. The signing secret is in the response and never again. */
  create: orgProcedure.input(z.object({ orgId, name, url, events })).mutation(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, ctx.org.orgId, "webhooks:manage");
    await assertCanCreate(ctx.org.orgId, "webhooks");
    assertUrl(input.url);
    const secret = generateWebhookSecret();
    const row = await ctx.prisma.webhook.create({
      data: {
        orgId: ctx.org.orgId,
        name: input.name,
        url: input.url,
        events: input.events,
        secretEncrypted: encryptWebhookSecret(secret),
        createdBy: ctx.user.id,
      },
      select: { id: true, name: true, url: true, events: true, active: true, createdAt: true },
    });
    return { ...row, secret };
  }),

  update: orgProcedure
    .input(z.object({ orgId, id, name: name.optional(), url: url.optional(), events: events.optional(), active: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireOrgPermission(ctx, ctx.org.orgId, "webhooks:manage");
      const hook = found(await ctx.prisma.webhook.findFirst({ where: { id: input.id, orgId: ctx.org.orgId }, select: { id: true } }), "Webhook");
      if (input.url !== undefined) assertUrl(input.url);
      const updated = await ctx.prisma.webhook.update({
        where: { id: hook.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.url !== undefined ? { url: input.url } : {}),
          ...(input.events !== undefined ? { events: input.events } : {}),
          ...(input.active === true ? { active: true, disabledAt: null, consecutiveFailures: 0 } : {}),
          ...(input.active === false ? { active: false } : {}),
        },
        select: { id: true, name: true, url: true, events: true, active: true, disabledAt: true },
      });
      return updated;
    }),

  delete: orgProcedure.input(z.object({ orgId, id })).mutation(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, ctx.org.orgId, "webhooks:manage");
    const hook = found(await ctx.prisma.webhook.findFirst({ where: { id: input.id, orgId: ctx.org.orgId }, select: { id: true } }), "Webhook");
    await ctx.prisma.webhook.delete({ where: { id: hook.id } });
    return { id: hook.id };
  }),

  /** Replace the signing secret. The new secret is returned once. */
  rotateSecret: orgProcedure.input(z.object({ orgId, id })).mutation(async ({ ctx, input }) => {
    await requireOrgPermission(ctx, ctx.org.orgId, "webhooks:manage");
    const hook = found(await ctx.prisma.webhook.findFirst({ where: { id: input.id, orgId: ctx.org.orgId }, select: { id: true } }), "Webhook");
    const secret = generateWebhookSecret();
    await ctx.prisma.webhook.update({ where: { id: hook.id }, data: { secretEncrypted: encryptWebhookSecret(secret) } });
    return { id: hook.id, secret };
  }),

  /** Queue a signed `webhook.test` delivery (outbound rate limit applies). */
  test: outboundProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const hook = found(await ctx.prisma.webhook.findUnique({ where: { id: input.id }, select: { id: true, orgId: true } }), "Webhook");
    await requireOrgPermission(ctx, hook.orgId, "webhooks:manage");
    const deliveryId = await queueTestDelivery(hook, ctx.user.id);
    return { deliveryId };
  }),

  /** Delivery log: status, timing and a short sanitized response excerpt only. */
  getDeliveries: orgProcedure
    .input(z.object({ orgId, webhookId: id, limit: z.number().int().min(1).max(50).default(20), cursor: id.optional() }))
    .query(async ({ ctx, input }) => {
      const hook = found(
        await ctx.prisma.webhook.findFirst({ where: { id: input.webhookId, orgId: ctx.org.orgId }, select: { id: true } }),
        "Webhook"
      );
      const rows = await ctx.prisma.webhookDelivery.findMany({
        where: { webhookId: hook.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          event: true,
          statusCode: true,
          durationMs: true,
          success: true,
          attemptCount: true,
          deliveredAt: true,
          createdAt: true,
          responseBody: true,
        },
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map(({ responseBody, ...d }) => ({
          ...d,
          status: deliveryStatus(d),
          responseExcerpt: responseBody ? sanitizeExcerpt(responseBody) : null,
        })),
        nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
      };
    }),
});
