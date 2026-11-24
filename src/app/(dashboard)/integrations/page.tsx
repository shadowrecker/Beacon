"use client";

import { Suspense, useMemo } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { IntegrationCard } from "@/components/integrations/integration-card";
import { OAuthBanner } from "@/components/integrations/oauth-banner";
import { CATEGORY_ORDER, type IntegrationRow, type ProviderInfo } from "@/components/integrations/types";
import { canManageIntegrations, useActiveRole } from "@/components/integrations/use-active-role";
import { isSyncActive } from "@/components/integrations/sync-status";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { trpc } from "@/lib/trpc";

export default function IntegrationsPage() {
  const providers = trpc.integration.providers.useQuery(undefined, { staleTime: 5 * 60_000 });
  const list = trpc.integration.list.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.some((r) => isSyncActive(r.lastSync?.status)) ? 5000 : false),
  });
  const { role } = useActiveRole();

  const byProvider = useMemo(() => new Map((list.data ?? []).map((r) => [r.provider, r] as const)), [list.data]);
  const canManage = list.data?.[0]?.canManage ?? canManageIntegrations(role);

  const connected: Array<{ p: ProviderInfo; row: IntegrationRow }> = [];
  const available: ProviderInfo[] = [];
  for (const p of providers.data ?? []) {
    const row = byProvider.get(p.provider);
    if (row && row.status !== "DISCONNECTED") connected.push({ p, row });
    else available.push(p);
  }
  available.sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name));

  const nameOf = (provider: string) => providers.data?.find((p) => p.provider === provider)?.name ?? "";
  const loading = providers.isLoading || list.isLoading;
  const error = providers.error ?? list.error;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Integrations"
        description="Sync feedback from the tools your customers and teams already use. Records become documents in the project you choose."
      />
      <Suspense fallback={null}>
        <OAuthBanner providerName={nameOf} />
      </Suspense>

      {loading ? (
        <LoadingState rows={4} label="Loading integrations" />
      ) : error ? (
        <ErrorState
          message={error.message}
          onRetry={() => {
            void providers.refetch();
            void list.refetch();
          }}
        />
      ) : (
        <>
          {connected.length > 0 && (
            <section aria-labelledby="connected-heading" className="space-y-3">
              <h2 id="connected-heading" className="text-lg font-semibold">
                Connected ({connected.length})
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {connected.map(({ p, row }) => (
                  <li key={p.provider}>
                    <IntegrationCard provider={p} integration={row} canManage={canManage} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-labelledby="available-heading" className="space-y-3">
            <h2 id="available-heading" className="text-lg font-semibold">
              {connected.length > 0 ? "Add another integration" : "Available integrations"}
            </h2>
            {!canManage && (
              <p className="text-sm text-muted-foreground">Only workspace owners and admins can connect integrations.</p>
            )}
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {available.map((p) => (
                <li key={p.provider}>
                  <IntegrationCard provider={p} integration={byProvider.get(p.provider)} canManage={canManage} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
