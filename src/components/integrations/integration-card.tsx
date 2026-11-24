"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, History, Loader2, Plug, RefreshCw, Settings2, Unplug } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { IntegrationSettingsDialog } from "./config-form";
import { ConnectDialog } from "./connect-dialog";
import { isSyncActive, SyncHistoryDialog, SyncStatusBadge } from "./sync-status";
import type { IntegrationRow, ProviderInfo } from "./types";

const STATUS_BADGE: Record<IntegrationRow["status"], { label: string; variant: "positive" | "negative" | "neutral" }> = {
  CONNECTED: { label: "Connected", variant: "positive" },
  ERROR: { label: "Needs attention", variant: "negative" },
  DISCONNECTED: { label: "Disconnected", variant: "neutral" },
};

interface IntegrationCardProps {
  provider: ProviderInfo;
  integration: IntegrationRow | undefined;
  /** Whether the caller can manage integrations in the active workspace. */
  canManage: boolean;
}

/** One provider: connection status, last sync, and per-card actions with their own pending state. */
export function IntegrationCard({ provider, integration, canManage }: IntegrationCardProps) {
  const utils = trpc.useUtils();
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const sync = trpc.integration.sync.useMutation({
    onSuccess: async (res) => {
      toast.success(res.alreadyRunning ? `A ${provider.name} sync is already running` : `${provider.name} sync started`);
      await Promise.all([utils.integration.list.invalidate(), utils.integration.syncHistory.invalidate()]);
    },
  });
  const disconnect = trpc.integration.disconnect.useMutation({
    onSuccess: async (res) => {
      setDisconnectOpen(false);
      toast.success(res.revoked ? `${provider.name} disconnected and access revoked` : `${provider.name} disconnected`);
      if (res.revokeHelp) toast.info(res.revokeHelp);
      await Promise.all([utils.integration.list.invalidate(), utils.marketplace.listInstalled.invalidate()]);
    },
  });

  const connected = integration && integration.status !== "DISCONNECTED";
  const status = integration ? STATUS_BADGE[integration.status] : null;
  const lastSync = integration?.lastSync ?? null;
  const syncing = isSyncActive(lastSync?.status);
  const notConfigured = provider.auth === "oauth" && !provider.configured;
  const accountLabel = typeof integration?.config.accountLabel === "string" ? integration.config.accountLabel : null;
  const credentialEntries = Object.entries(integration?.credentials ?? {}).filter(([k]) => k !== "expiresAt");

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-muted" aria-hidden>
              <Plug className="h-4 w-4 text-muted-foreground" />
            </span>
            <CardTitle className="truncate text-base">{provider.name}</CardTitle>
          </div>
          <div className="flex flex-shrink-0 flex-wrap justify-end gap-1">
            {status && connected && <Badge variant={status.variant}>{status.label}</Badge>}
            {notConfigured && !connected && <Badge variant="outline">Not configured</Badge>}
          </div>
        </div>
        <CardDescription>{provider.description}</CardDescription>
        <div className="flex flex-wrap gap-1 text-xs">
          <Badge variant="secondary">{provider.category}</Badge>
          <Badge variant="outline">{provider.auth === "oauth" ? "OAuth" : "API token"}</Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-3 text-sm">
        {connected && integration ? (
          <>
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
              {accountLabel && (
                <>
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="truncate">{accountLabel}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Project</dt>
              <dd className="truncate">
                {integration.project ? (
                  <Link href={`/projects/${integration.project.id}`} className="underline-offset-4 hover:underline">
                    {integration.project.name}
                  </Link>
                ) : (
                  <span className="text-destructive">Not set</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Last sync</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {lastSync ? (
                  <>
                    <SyncStatusBadge status={lastSync.status} />
                    <time dateTime={new Date(lastSync.startedAt).toISOString()} className="text-muted-foreground">
                      {formatDistanceToNow(new Date(lastSync.startedAt), { addSuffix: true })}
                    </time>
                  </>
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </dd>
              {lastSync && lastSync.status === "COMPLETED" && (
                <>
                  <dt className="text-muted-foreground">Records</dt>
                  <dd>{lastSync.recordsProcessed.toLocaleString()}</dd>
                </>
              )}
            </dl>
            {integration.hasMore && !syncing && (
              <p className="text-xs text-muted-foreground">More records are waiting: the next sync continues where this one stopped.</p>
            )}
            {(integration.lastError || (lastSync?.status === "FAILED" && lastSync.errorMessage)) && (
              <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
                <span className="break-words">{integration.lastError ?? lastSync?.errorMessage}</span>
              </p>
            )}
            {credentialEntries.length > 0 && (
              <details className="rounded-md border px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Stored credentials (masked)</summary>
                <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                  {credentialEntries.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="truncate font-mono">{v}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">{provider.syncs}.</p>
        )}
        {notConfigured && !connected && (
          <p className="text-xs text-muted-foreground">
            An administrator must set {provider.provider}_CLIENT_ID and {provider.provider}_CLIENT_SECRET before {provider.name} can be connected.
          </p>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        {connected && integration ? (
          <>
            {canManage && integration.status === "CONNECTED" && (
              <Button size="sm" onClick={() => sync.mutate({ id: integration.id })} disabled={sync.isPending || syncing || !integration.project}>
                {sync.isPending || syncing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />}
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
            )}
            {canManage && integration.status === "ERROR" && (
              <Button size="sm" onClick={() => setConnectOpen(true)} disabled={notConfigured}>
                Reconnect
              </Button>
            )}
            {canManage && (
              <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
                <Settings2 className="mr-1.5 h-4 w-4" aria-hidden />
                Settings
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
              <History className="mr-1.5 h-4 w-4" aria-hidden />
              History
            </Button>
            {canManage && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDisconnectOpen(true)}>
                <Unplug className="mr-1.5 h-4 w-4" aria-hidden />
                Disconnect
              </Button>
            )}
          </>
        ) : canManage ? (
          <Button size="sm" onClick={() => setConnectOpen(true)} disabled={notConfigured}>
            {integration ? "Reconnect" : "Connect"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Ask a workspace owner or admin to connect {provider.name}.</p>
        )}
      </CardFooter>

      <ConnectDialog provider={provider} open={connectOpen} onOpenChange={setConnectOpen} defaultProjectId={integration?.project?.id} />
      {integration && (
        <>
          <IntegrationSettingsDialog integration={integration} provider={provider} open={settingsOpen} onOpenChange={setSettingsOpen} />
          <SyncHistoryDialog integrationId={integration.id} name={provider.name} open={historyOpen} onOpenChange={setHistoryOpen} />
        </>
      )}

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {provider.name}?</DialogTitle>
            <DialogDescription>
              Syncing stops and the stored credentials are deleted. {provider.revokeHelp} Documents already synced stay in their project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectOpen(false)} disabled={disconnect.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => integration && disconnect.mutate({ id: integration.id })} disabled={disconnect.isPending}>
              {disconnect.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
