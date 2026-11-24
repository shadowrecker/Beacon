/**
 * The integration sync engine (the single implementation behind
 * QUEUE.INTEGRATION_SYNC).
 *
 * The producer (router, OAuth callback, scheduler) creates an IntegrationSync
 * row in PENDING; this engine moves that same row RUNNING → COMPLETED, or the
 * worker's onFinalFailure moves it to FAILED. Records are ingested through
 * createDocumentFromText (idempotent on integrationId + externalId) and the
 * connector cursor is persisted after every batch, so a retry resumes instead
 * of starting over. `lastSyncAt` is the sync's start time, so records updated
 * while a sync runs are picked up by the next one.
 */
import { Prisma, type IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { createDocumentFromText } from "../documents/ingest";
import { emitEvent } from "../events/bus";
import { failureMessage, NonRetryableError } from "../jobs/worker";
import { notify } from "../notifications/notify";
import { decryptCredentials, saveIntegrationCredentials, type Credentials } from "./credentials";
import { createProviderHttp, ProviderAuthError } from "./http";
import { getConnector, providerInfo } from "./index";
import { canRefresh, expiresSoon, refreshCredentials } from "./oauth";
import { effectiveConfig } from "./service";
import { DEFAULT_LIMITS, type SyncLimits } from "./types";

export const DEFAULT_SYNC_INTERVAL_MINUTES = 360;
export const DEFAULT_BACKFILL_DAYS = 30;

/** Stored Integration.syncCursor: the connector's cursor plus whether more data is pending. */
const storedCursorSchema = z.object({ v: z.literal(1), state: z.unknown(), hasMore: z.boolean() });

export function readStoredCursor(raw: unknown): { state: unknown; hasMore: boolean } {
  const parsed = storedCursorSchema.safeParse(raw);
  return parsed.success ? { state: parsed.data.state ?? null, hasMore: parsed.data.hasMore } : { state: null, hasMore: false };
}

function storedCursor(state: unknown, hasMore: boolean): Prisma.InputJsonValue {
  return { v: 1, state: (state ?? null) as Prisma.InputJsonValue, hasMore } as Prisma.InputJsonValue;
}

export interface SyncOutcome {
  status: "completed" | "skipped";
  records: number;
  created: number;
  hasMore: boolean;
}

export async function runIntegrationSync(
  data: { integrationId: string; syncId: string },
  opts: { log: Logger; limits?: SyncLimits; now?: Date }
): Promise<SyncOutcome> {
  const sync = await prisma.integrationSync.findFirst({
    where: { id: data.syncId, integrationId: data.integrationId },
    select: { id: true, status: true, startedAt: true, recordsProcessed: true },
  });
  if (!sync) throw new NonRetryableError("Sync not found");
  if (sync.status === "COMPLETED" || sync.status === "FAILED") {
    return { status: "skipped", records: sync.recordsProcessed, created: 0, hasMore: false };
  }

  const integ = await prisma.integration.findUnique({
    where: { id: data.integrationId },
    select: { id: true, orgId: true, provider: true, status: true, projectId: true, config: true, syncCursor: true, credentialsEncrypted: true },
  });
  if (!integ || integ.status !== "CONNECTED" || !integ.credentialsEncrypted) {
    throw new NonRetryableError("The integration is not connected");
  }
  if (!integ.projectId) throw new NonRetryableError("Choose a target project for this integration before syncing");
  const project = await prisma.project.findFirst({ where: { id: integ.projectId, orgId: integ.orgId }, select: { id: true } });
  if (!project) throw new NonRetryableError("The target project no longer exists. Choose another project.");

  const concurrent = await prisma.integrationSync.findFirst({
    where: { integrationId: integ.id, status: "RUNNING", id: { not: sync.id }, startedAt: { gt: new Date(Date.now() - 3 * 3600_000) } },
    select: { id: true },
  });
  if (concurrent) throw new NonRetryableError("Another sync for this integration is already running");

  const startedAt = sync.status === "RUNNING" ? sync.startedAt : new Date();
  await prisma.integrationSync.update({ where: { id: sync.id }, data: { status: "RUNNING", startedAt, errorMessage: null } });

  const provider = integ.provider;
  const connector = getConnector(provider);
  const name = providerInfo(provider).name;
  const config = effectiveConfig(provider, integ.config);
  let credentials: Credentials = decryptCredentials(integ.credentialsEncrypted) ?? {};

  const refresh = async () => {
    credentials = await refreshCredentials(provider, credentials, config);
    await saveIntegrationCredentials(integ.id, credentials);
  };
  try {
    if (canRefresh(provider, credentials) && expiresSoon(credentials)) await refresh();
  } catch (err) {
    if (err instanceof ProviderAuthError) await markAuthFailure(integ.id, err);
    throw err;
  }

  const http = createProviderHttp({
    provider: name,
    authHeaders: () => connector.authHeaders(credentials, config),
    onUnauthorized: canRefresh(provider, credentials)
      ? async () => {
          await refresh();
          return true;
        }
      : undefined,
  });

  const backfillDays = Number(config.backfillDays) || DEFAULT_BACKFILL_DAYS;
  let processed = sync.recordsProcessed;
  let created = 0;
  let hasMore = false;
  const { state } = readStoredCursor(integ.syncCursor);

  try {
    for await (const batch of connector.sync({
      integrationId: integ.id,
      credentials,
      config,
      cursor: state,
      http,
      limits: opts.limits ?? DEFAULT_LIMITS,
      backfillDays,
      now: opts.now ?? new Date(),
      log: opts.log,
    })) {
      for (const rec of batch.records) {
        if (!rec.text.trim()) continue;
        const res = await createDocumentFromText({
          projectId: project.id,
          integrationId: integ.id,
          externalId: rec.externalId.slice(0, 300),
          source: "INTEGRATION",
          type: rec.type,
          title: rec.title,
          text: rec.text,
          sourceUrl: rec.sourceUrl ?? null,
          metadata: (rec.metadata ?? {}) as Prisma.InputJsonValue,
        });
        if (res.created) created++;
        processed++;
      }
      hasMore = !batch.done;
      // Persist progress after every batch so a retry resumes here.
      await prisma.$transaction([
        prisma.integration.updateMany({ where: { id: integ.id, status: "CONNECTED" }, data: { syncCursor: storedCursor(batch.cursor, hasMore) } }),
        prisma.integrationSync.update({ where: { id: sync.id }, data: { recordsProcessed: processed } }),
      ]);
    }
  } catch (err) {
    if (err instanceof ProviderAuthError) await markAuthFailure(integ.id, err);
    throw err;
  }

  await prisma.$transaction([
    prisma.integration.updateMany({ where: { id: integ.id, status: "CONNECTED" }, data: { lastSyncAt: startedAt, lastError: null } }),
    prisma.integrationSync.update({
      where: { id: sync.id },
      data: { status: "COMPLETED", completedAt: new Date(), recordsProcessed: processed, errorMessage: null },
    }),
  ]);
  await emitEvent({
    orgId: integ.orgId,
    projectId: project.id,
    type: "integration.synced",
    payload: { integrationId: integ.id, provider, records: processed },
  });
  opts.log.info("integration sync completed", { provider, records: processed, created, hasMore });
  return { status: "completed", records: processed, created, hasMore };
}

async function markAuthFailure(integrationId: string, err: ProviderAuthError): Promise<void> {
  await prisma.integration.updateMany({
    where: { id: integrationId, status: "CONNECTED" },
    data: { status: "ERROR", lastError: err.message },
  });
}

/** onFinalFailure: the producer's row → FAILED, record the error, tell org admins. Idempotent. */
export async function markSyncFailed(data: { integrationId: string; syncId: string }, err: Error): Promise<void> {
  const message = failureMessage(err);
  const updated = await prisma.integrationSync.updateMany({
    where: { id: data.syncId, integrationId: data.integrationId, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "FAILED", errorMessage: message, completedAt: new Date() },
  });
  const integ = await prisma.integration.findUnique({
    where: { id: data.integrationId },
    select: { id: true, orgId: true, provider: true, projectId: true, status: true },
  });
  if (!integ) return;
  if (integ.status !== "DISCONNECTED") {
    await prisma.integration.update({ where: { id: integ.id }, data: { lastError: message } });
  }
  if (updated.count === 0) return; // already terminal: don't emit or notify twice

  await emitEvent({
    orgId: integ.orgId,
    projectId: integ.projectId,
    type: "integration.failed",
    payload: { integrationId: integ.id, provider: integ.provider, error: message },
  });
  await notifyAdmins(integ.orgId, integ.provider, integ.id, data.syncId, message);
}

async function notifyAdmins(orgId: string, provider: IntegrationProvider, integrationId: string, syncId: string, message: string): Promise<void> {
  const admins = await prisma.orgMember.findMany({
    where: { orgId, role: { in: ["OWNER", "ADMIN"] }, joinedAt: { not: null } },
    select: { userId: true },
    take: 50,
  });
  const name = providerInfo(provider).name;
  await notify({
    userIds: admins.map((a) => a.userId),
    type: "INTEGRATION_SYNC",
    title: `${name} sync failed`,
    message,
    resourceType: "integration",
    resourceId: integrationId,
    href: "/integrations",
    dedupeKey: `integration-failed:${syncId}`,
  });
}
