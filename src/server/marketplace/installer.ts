/**
 * Marketplace install / uninstall for the active organization.
 *
 * Installing records a ConnectorInstall (one per connector per org) linked to the
 * org's Integration for that provider. If the provider isn't connected yet, the
 * caller is sent into the connect flow (OAuth redirect or API-token form); the
 * connection links the install once it succeeds (service.linkMarketplaceInstall).
 */
import type { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PROVIDERS, providerInfo } from "../integrations/index";
import { isOAuthConfigured } from "../integrations/oauth";
import { disconnectIntegration } from "../integrations/service";

export type InstallNext =
  | { kind: "connected"; provider: IntegrationProvider }
  | { kind: "oauth"; provider: IntegrationProvider; configured: boolean }
  | { kind: "apiKey"; provider: IntegrationProvider };

export function connectorProvider(provider: string): IntegrationProvider | null {
  return (PROVIDERS as readonly string[]).includes(provider) ? (provider as IntegrationProvider) : null;
}

export async function installConnector(input: {
  connectorId: string;
  provider: IntegrationProvider;
  orgId: string;
  userId: string;
}): Promise<{ installId: string; created: boolean; next: InstallNext }> {
  const integration = await prisma.integration.findUnique({
    where: { orgId_provider: { orgId: input.orgId, provider: input.provider } },
    select: { id: true, status: true },
  });
  const connected = integration?.status === "CONNECTED";

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.connectorInstall.findUnique({
      where: { connectorId_orgId: { connectorId: input.connectorId, orgId: input.orgId } },
      select: { id: true },
    });
    if (existing) {
      if (connected) {
        await tx.connectorInstall.update({
          where: { id: existing.id },
          data: { integrationId: integration!.id, status: "ACTIVE", configuredAt: new Date() },
        });
      }
      return { installId: existing.id, created: false };
    }
    const created = await tx.connectorInstall.create({
      data: {
        connectorId: input.connectorId,
        orgId: input.orgId,
        installedBy: input.userId,
        integrationId: connected ? integration!.id : null,
        status: connected ? "ACTIVE" : "INSTALLED",
        configuredAt: connected ? new Date() : null,
      },
      select: { id: true },
    });
    await tx.marketplaceConnector.update({ where: { id: input.connectorId }, data: { installCount: { increment: 1 } } });
    return { installId: created.id, created: true };
  });

  const info = providerInfo(input.provider);
  const next: InstallNext = connected
    ? { kind: "connected", provider: input.provider }
    : info.auth === "oauth"
      ? { kind: "oauth", provider: input.provider, configured: isOAuthConfigured(input.provider) }
      : { kind: "apiKey", provider: input.provider };
  return { ...result, next };
}

export async function uninstallConnector(input: {
  connectorId: string;
  orgId: string;
  disconnect: boolean;
}): Promise<{ removed: boolean; disconnected: boolean }> {
  const install = await prisma.connectorInstall.findUnique({
    where: { connectorId_orgId: { connectorId: input.connectorId, orgId: input.orgId } },
    select: { id: true, integrationId: true },
  });
  if (!install) return { removed: false, disconnected: false };
  await prisma.$transaction([
    prisma.connectorInstall.delete({ where: { id: install.id } }),
    prisma.marketplaceConnector.updateMany({
      where: { id: input.connectorId, installCount: { gt: 0 } },
      data: { installCount: { decrement: 1 } },
    }),
  ]);
  let disconnected = false;
  if (input.disconnect && install.integrationId) {
    const integ = await prisma.integration.findFirst({ where: { id: install.integrationId, orgId: input.orgId }, select: { id: true } });
    if (integ) {
      await disconnectIntegration(integ.id);
      disconnected = true;
    }
  }
  return { removed: true, disconnected };
}
