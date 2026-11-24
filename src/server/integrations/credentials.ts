/**
 * Integration credentials: encrypted at rest, decrypted only server-side.
 *
 * Every caller that needs a provider token (sync, workflow actions, handoff
 * export, roadmap import) goes through `getOrgIntegrationCredentials(orgId, ...)`
 * with an orgId derived server-side from a resource the caller is authorized
 * for, never from request parameters. That is what closes the workflow
 * "confused deputy" credential-theft hole.
 */
import type { IntegrationProvider } from "@prisma/client";
import { prisma, type DbClient } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/crypto";

export type Credentials = Record<string, string>;

export function encryptCredentials(credentials: Credentials): { credentialsEncrypted: string; credentialsKeyVersion: number } {
  const { envelope, keyVersion } = encryptJson(credentials);
  return { credentialsEncrypted: envelope, credentialsKeyVersion: keyVersion };
}

export function decryptCredentials(envelope: string | null): Credentials | null {
  if (!envelope) return null;
  return decryptJson<Credentials>(envelope);
}

export interface ResolvedIntegration {
  id: string;
  orgId: string;
  provider: IntegrationProvider;
  projectId: string | null;
  config: unknown;
  credentials: Credentials;
}

/** The org's connected integration for `provider`, with decrypted credentials, or null. */
export async function getOrgIntegrationCredentials(
  orgId: string,
  provider: IntegrationProvider,
  db: DbClient = prisma
): Promise<ResolvedIntegration | null> {
  const row = await db.integration.findUnique({
    where: { orgId_provider: { orgId, provider } },
    select: { id: true, orgId: true, provider: true, projectId: true, config: true, status: true, credentialsEncrypted: true },
  });
  if (!row || row.status !== "CONNECTED") return null;
  const credentials = decryptCredentials(row.credentialsEncrypted);
  if (!credentials) return null;
  return { id: row.id, orgId: row.orgId, provider: row.provider, projectId: row.projectId, config: row.config, credentials };
}

/** Store (or rotate) credentials for an integration row. */
export async function saveIntegrationCredentials(integrationId: string, credentials: Credentials, db: DbClient = prisma): Promise<void> {
  await db.integration.update({ where: { id: integrationId }, data: encryptCredentials(credentials) });
}

/** Redact a credentials object for display (never return secrets to clients). */
export function describeCredentials(credentials: Credentials | null): Record<string, string> {
  if (!credentials) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(credentials)) {
    const sensitive = /token|secret|key|password/i.test(k);
    out[k] = sensitive ? `••••${String(v).slice(-4)}` : String(v);
  }
  return out;
}
