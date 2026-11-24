/**
 * Integrations. Org-scoped: every integration belongs to the active
 * organization; writes require integrations:manage (OWNER/ADMIN). Credentials
 * are never returned, only their masked form (describeCredentials).
 *
 * OAuth providers connect through /api/integrations/oauth/start (browser
 * redirect); API-token providers connect here after a live credential check.
 */
import type { IntegrationProvider, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { can, requireProjectAccess } from "../auth/access";
import { orgProcedure, protectedProcedure, rateLimited, router } from "../trpc";
import { decryptCredentials, describeCredentials } from "../integrations/credentials";
import { getConnector, PROVIDER_CATALOG, providerInfo } from "../integrations/index";
import { isOAuthConfigured } from "../integrations/oauth";
import { activeSync, connectApiKeyIntegration, disconnectIntegration, effectiveConfig, startSync } from "../integrations/service";
import { readStoredCursor } from "../integrations/sync";
import { amplitudeConfigSchema, amplitudeCredentialSchema } from "../integrations/amplitude";
import { jiraConfigSchema, jiraCredentialSchema } from "../integrations/jira";
import { linearConfigSchema, linearCredentialSchema } from "../integrations/linear";
import { mixpanelConfigSchema, mixpanelCredentialSchema } from "../integrations/mixpanel";
import { notionConfigSchema, notionCredentialSchema } from "../integrations/notion";
import { productboardConfigSchema, productboardCredentialSchema } from "../integrations/productboard";

const id = z.string().min(1).max(64);

const connectInput = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("LINEAR"), projectId: id, credentials: linearCredentialSchema, config: linearConfigSchema.optional() }),
  z.object({ provider: z.literal("JIRA"), projectId: id, credentials: jiraCredentialSchema, config: jiraConfigSchema.optional() }),
  z.object({ provider: z.literal("NOTION"), projectId: id, credentials: notionCredentialSchema, config: notionConfigSchema.optional() }),
  z.object({ provider: z.literal("PRODUCTBOARD"), projectId: id, credentials: productboardCredentialSchema, config: productboardConfigSchema.optional() }),
  z.object({ provider: z.literal("MIXPANEL"), projectId: id, credentials: mixpanelCredentialSchema, config: mixpanelConfigSchema.optional() }),
  z.object({ provider: z.literal("AMPLITUDE"), projectId: id, credentials: amplitudeCredentialSchema, config: amplitudeConfigSchema.optional() }),
]);

type OrgCtx = Parameters<typeof requireProjectAccess>[0] & { org: { orgId: string; role: Parameters<typeof can>[0] } };

function requireManage(ctx: OrgCtx): void {
  if (!can(ctx.org.role, "integrations:manage")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only workspace owners and admins can manage integrations" });
  }
}

/** A project in the active org that the caller can write to (foreign or unknown → NOT_FOUND). */
async function requireOrgProject(ctx: OrgCtx, projectId: string) {
  const project = await requireProjectAccess(ctx, projectId, "project:write");
  if (project.orgId !== ctx.org.orgId) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
  return project;
}

async function requireIntegration(ctx: OrgCtx, integrationId: string) {
  const row = await ctx.prisma.integration.findFirst({
    where: { id: integrationId, orgId: ctx.org.orgId },
    select: { id: true, provider: true, status: true, projectId: true, config: true },
  });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Integration not found" });
  return row;
}

/** Settings safe to show: user-editable config plus the account label (no tokens live in config). */
function publicConfig(provider: IntegrationProvider, raw: unknown) {
  const cfg = effectiveConfig(provider, raw);
  const { account: _account, ...rest } = cfg;
  return rest;
}

export const integrationRouter = router({
  /** Static provider catalog with configured / not-configured state. */
  providers: protectedProcedure.query(() =>
    PROVIDER_CATALOG.map((p) => ({ ...p, configured: p.auth === "apiKey" || isOAuthConfigured(p.provider) }))
  ),

  list: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.prisma.integration.findMany({
      where: { orgId: ctx.org.orgId },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: {
        id: true,
        provider: true,
        status: true,
        projectId: true,
        config: true,
        syncCursor: true,
        lastSyncAt: true,
        lastError: true,
        createdAt: true,
        credentialsEncrypted: true,
        syncs: {
          orderBy: { startedAt: "desc" },
          take: 1,
          select: { id: true, status: true, recordsProcessed: true, errorMessage: true, startedAt: true, completedAt: true },
        },
      },
    });
    const projectIds = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => !!p))];
    const projects = projectIds.length
      ? await ctx.prisma.project.findMany({ where: { id: { in: projectIds }, orgId: ctx.org.orgId }, select: { id: true, name: true } })
      : [];
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const canManage = can(ctx.org.role, "integrations:manage");

    return rows.map((r) => {
      let credentials: Record<string, string> = {};
      try {
        credentials = describeCredentials(decryptCredentials(r.credentialsEncrypted));
      } catch {
        credentials = {};
      }
      return {
        id: r.id,
        provider: r.provider,
        name: providerInfo(r.provider).name,
        status: r.status,
        project: r.projectId && projectName.has(r.projectId) ? { id: r.projectId, name: projectName.get(r.projectId)! } : null,
        config: publicConfig(r.provider, r.config),
        credentials,
        lastSyncAt: r.lastSyncAt,
        lastError: r.lastError,
        hasMore: readStoredCursor(r.syncCursor).hasMore,
        lastSync: r.syncs[0] ?? null,
        createdAt: r.createdAt,
        canManage,
      };
    });
  }),

  /** Connect an API-token provider (verified live before saving). */
  connect: orgProcedure
    .use(rateLimited(RATE_LIMITS.outbound))
    .input(connectInput)
    .mutation(async ({ ctx, input }) => {
      requireManage(ctx);
      const project = await requireOrgProject(ctx, input.projectId);
      const res = await connectApiKeyIntegration({
        orgId: ctx.org.orgId,
        userId: ctx.user.id,
        provider: input.provider,
        projectId: project.id,
        credentials: input.credentials as Record<string, string>,
        config: (input.config ?? {}) as Record<string, unknown>,
      });
      return { id: res.integrationId, syncId: res.syncId, accountLabel: res.accountLabel };
    }),

  setTargetProject: orgProcedure
    .input(z.object({ id, projectId: id }))
    .mutation(async ({ ctx, input }) => {
      requireManage(ctx);
      const integ = await requireIntegration(ctx, input.id);
      const project = await requireOrgProject(ctx, input.projectId);
      await ctx.prisma.integration.update({ where: { id: integ.id }, data: { projectId: project.id } });
      return { id: integ.id, project: { id: project.id, name: project.name } };
    }),

  updateConfig: orgProcedure
    .input(z.object({ id, config: z.record(z.string().max(60), z.unknown()).refine((c) => Object.keys(c).length <= 20, "Too many settings") }))
    .mutation(async ({ ctx, input }) => {
      requireManage(ctx);
      const integ = await requireIntegration(ctx, input.id);
      const connector = getConnector(integ.provider);
      const { account: _a, accountLabel: _l, ...userInput } = input.config;
      const merged: Record<string, unknown> = { ...publicConfig(integ.provider, integ.config), ...userInput };
      // Empty values clear a setting.
      for (const [k, v] of Object.entries(merged)) if (v === "" || v === null) delete merged[k];
      const parsed = connector.configSchema.safeParse(merged);
      if (!parsed.success) {
        throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid settings" });
      }
      const stored = effectiveConfig(integ.provider, integ.config);
      const next = { ...(parsed.data as Record<string, unknown>), ...(stored.account ? { account: stored.account } : {}), ...(stored.accountLabel ? { accountLabel: stored.accountLabel } : {}) };
      await ctx.prisma.integration.update({ where: { id: integ.id }, data: { config: next as Prisma.InputJsonValue } });
      return { id: integ.id, config: publicConfig(integ.provider, next) };
    }),

  sync: orgProcedure
    .use(rateLimited(RATE_LIMITS.outbound))
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      requireManage(ctx);
      const integ = await requireIntegration(ctx, input.id);
      if (integ.status !== "CONNECTED") throw new TRPCError({ code: "BAD_REQUEST", message: "Reconnect this integration before syncing" });
      if (!integ.projectId) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a target project first" });
      const active = await activeSync(integ.id);
      if (active) return { syncId: active.id, alreadyRunning: true };
      const syncId = await startSync(integ.id);
      return { syncId, alreadyRunning: false };
    }),

  syncHistory: orgProcedure
    .input(z.object({ integrationId: id, limit: z.number().int().min(1).max(100).default(10), cursor: id.optional() }))
    .query(async ({ ctx, input }) => {
      const integ = await requireIntegration(ctx, input.integrationId);
      const rows = await ctx.prisma.integrationSync.findMany({
        where: { integrationId: integ.id },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, status: true, recordsProcessed: true, errorMessage: true, startedAt: true, completedAt: true },
      });
      const items = rows.slice(0, input.limit);
      return { items, nextCursor: rows.length > input.limit ? items[items.length - 1].id : null };
    }),

  disconnect: orgProcedure
    .use(rateLimited(RATE_LIMITS.outbound))
    .input(z.object({ id }))
    .mutation(async ({ ctx, input }) => {
      requireManage(ctx);
      const integ = await requireIntegration(ctx, input.id);
      const { revoked } = await disconnectIntegration(integ.id);
      return { id: integ.id, revoked, revokeHelp: revoked ? null : providerInfo(integ.provider).revokeHelp };
    }),
});
