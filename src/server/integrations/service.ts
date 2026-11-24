/**
 * Integration lifecycle shared by the integration router, the OAuth callback,
 * the marketplace installer and the scheduler: connect (with a live credential
 * check), start a sync, link marketplace installs, disconnect (with provider
 * token revocation).
 */
import { Prisma, type IntegrationProvider } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { prisma, type DbClient } from "@/lib/db";
import { logger } from "@/lib/logger";
import { enqueue, QUEUE } from "../jobs/queues";
import { NonRetryableError } from "../jobs/worker";
import { assertCanCreate } from "../usage/entitlements";
import { decryptCredentials, encryptCredentials, type Credentials } from "./credentials";
import { createProviderHttp, ProviderAuthError, ProviderError } from "./http";
import { getConnector, providerInfo } from "./index";
import { revokeCredentials } from "./oauth";

export interface StoredConfig extends Record<string, unknown> {
  account?: Record<string, string>;
  accountLabel?: string;
}

/** Parse stored config with the connector's schema, keeping server-derived account details. */
export function effectiveConfig(provider: IntegrationProvider, raw: unknown): StoredConfig {
  const stored = (raw && typeof raw === "object" ? raw : {}) as StoredConfig;
  const parsed = getConnector(provider).configSchema.safeParse(stored);
  return {
    ...(parsed.success ? (parsed.data as Record<string, unknown>) : {}),
    ...(stored.account ? { account: stored.account } : {}),
    ...(stored.accountLabel ? { accountLabel: stored.accountLabel } : {}),
  };
}

/** Create a PENDING sync row and enqueue it. The worker updates this same row. */
export async function startSync(integrationId: string, opts: { syncId?: string } = {}, db: DbClient = prisma): Promise<string> {
  const sync = await db.integrationSync.create({
    data: { ...(opts.syncId ? { id: opts.syncId } : {}), integrationId, status: "PENDING" },
    select: { id: true },
  });
  await enqueue(QUEUE.INTEGRATION_SYNC, { integrationId, syncId: sync.id }, { jobId: `sync_${sync.id}` });
  return sync.id;
}

export async function activeSync(integrationId: string, db: DbClient = prisma) {
  return db.integrationSync.findFirst({
    where: { integrationId, status: { in: ["PENDING", "RUNNING"] } },
    select: { id: true, status: true },
    orderBy: { startedAt: "desc" },
  });
}

/** Attach the org's marketplace install for this provider (if any) to the integration. */
export async function linkMarketplaceInstall(orgId: string, provider: IntegrationProvider, integrationId: string, db: DbClient = prisma): Promise<void> {
  const connector = await db.marketplaceConnector.findFirst({ where: { provider }, select: { id: true } });
  if (!connector) return;
  await db.connectorInstall.updateMany({
    where: { connectorId: connector.id, orgId },
    data: { integrationId, status: "ACTIVE", configuredAt: new Date() },
  });
}

export interface SaveConnectionInput {
  orgId: string;
  userId: string;
  provider: IntegrationProvider;
  projectId: string;
  credentials: Credentials;
  /** User settings (already validated); merged over any existing settings. */
  config?: Record<string, unknown>;
  account?: Record<string, string>;
  accountLabel?: string;
}

/**
 * Store a verified connection (encrypted), link marketplace installs and start
 * the initial sync. Reconnecting resets the cursor; re-ingest is idempotent.
 */
export async function saveConnectedIntegration(input: SaveConnectionInput): Promise<{ integrationId: string; syncId: string }> {
  const existing = await prisma.integration.findUnique({
    where: { orgId_provider: { orgId: input.orgId, provider: input.provider } },
    select: { id: true, config: true },
  });
  if (!existing) await assertCanCreate(input.orgId, "integrations");

  const previous = existing ? effectiveConfig(input.provider, existing.config) : {};
  const config: StoredConfig = {
    ...previous,
    ...(input.config ?? {}),
    ...(input.account ? { account: input.account } : {}),
    ...(input.accountLabel ? { accountLabel: input.accountLabel.slice(0, 200) } : {}),
  };
  const data = {
    status: "CONNECTED" as const,
    ...encryptCredentials(input.credentials),
    projectId: input.projectId,
    userId: input.userId,
    config: config as Prisma.InputJsonValue,
    syncCursor: Prisma.DbNull,
    lastError: null,
  };
  const integration = await prisma.integration.upsert({
    where: { orgId_provider: { orgId: input.orgId, provider: input.provider } },
    update: data,
    create: { ...data, orgId: input.orgId, provider: input.provider },
    select: { id: true },
  });
  await linkMarketplaceInstall(input.orgId, input.provider, integration.id);
  const active = await activeSync(integration.id);
  const syncId = active?.id ?? (await startSync(integration.id));
  return { integrationId: integration.id, syncId };
}

/** Map connector failures during a live credential check to user-facing errors. */
export function connectionError(provider: IntegrationProvider, err: unknown): TRPCError {
  const name = providerInfo(provider).name;
  if (err instanceof ProviderAuthError) return new TRPCError({ code: "BAD_REQUEST", message: `${name} rejected these credentials. Check them and try again.` });
  if (err instanceof ProviderError) {
    if (err.status === 403) return new TRPCError({ code: "BAD_REQUEST", message: `${name} accepted the credentials but they lack the required permissions.` });
    if (err.status === 404) return new TRPCError({ code: "BAD_REQUEST", message: `${name} could not find that account or site. Check the details.` });
    if (err.status === 429) return new TRPCError({ code: "TOO_MANY_REQUESTS", message: `${name} is rate limiting requests. Try again in a minute.` });
    return new TRPCError({ code: "BAD_REQUEST", message: `Could not verify the connection with ${name} (status ${err.status}).` });
  }
  if (err instanceof NonRetryableError) return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  logger.error("integration credential check failed", { provider, err });
  return new TRPCError({ code: "BAD_REQUEST", message: `Could not reach ${name}. Try again.` });
}

/** Verify API-token credentials live, then save the connection. */
export async function connectApiKeyIntegration(input: Omit<SaveConnectionInput, "account" | "accountLabel">): Promise<{ integrationId: string; syncId: string; accountLabel: string | null }> {
  const connector = getConnector(input.provider);
  if (connector.auth !== "apiKey" || !connector.credentialSchema) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `${providerInfo(input.provider).name} connects with OAuth` });
  }
  const credentials = connector.credentialSchema.parse(input.credentials);
  const config = connector.configSchema.parse(input.config ?? {}) as Record<string, unknown>;
  const http = createProviderHttp({ provider: providerInfo(input.provider).name, authHeaders: () => connector.authHeaders(credentials, config) });
  let test;
  try {
    test = await connector.testConnection(http, credentials, config);
  } catch (err) {
    throw connectionError(input.provider, err);
  }
  const saved = await saveConnectedIntegration({ ...input, credentials, config, account: test.account, accountLabel: test.accountLabel });
  return { ...saved, accountLabel: test.accountLabel ?? null };
}

/**
 * Disconnect: revoke the provider token where the provider has an API for it
 * (best effort), then delete the stored credentials and cursor. Documents that
 * were already synced stay in their project.
 */
export async function disconnectIntegration(integrationId: string): Promise<{ revoked: boolean }> {
  const row = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { id: true, provider: true, credentialsEncrypted: true, config: true },
  });
  if (!row) return { revoked: false };
  let revoked = false;
  try {
    const creds = decryptCredentials(row.credentialsEncrypted);
    if (creds) revoked = await revokeCredentials(row.provider, creds, effectiveConfig(row.provider, row.config));
  } catch (err) {
    logger.warn("provider token revocation failed; deleting local credentials anyway", { integrationId, provider: row.provider, err });
  }
  await prisma.$transaction([
    prisma.integration.update({
      where: { id: row.id },
      data: { status: "DISCONNECTED", credentialsEncrypted: null, credentialsKeyVersion: null, syncCursor: Prisma.DbNull, lastError: null },
    }),
    prisma.integrationSync.updateMany({
      where: { integrationId: row.id, status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "FAILED", errorMessage: "The integration was disconnected", completedAt: new Date() },
    }),
    prisma.connectorInstall.updateMany({ where: { integrationId: row.id }, data: { status: "DISABLED" } }),
  ]);
  return { revoked };
}
