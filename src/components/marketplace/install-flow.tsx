"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { ApiKeyConnectForm, OAuthStartForm } from "@/components/integrations/credential-form";
import { ProjectSelect } from "@/components/integrations/project-select";

type Detail = RouterOutputs["marketplace"]["get"];

/**
 * Install → connect. Installing records the connector for the workspace; if the
 * provider isn't connected yet, the matching connect step (OAuth consent or an
 * API-token form) follows on the same panel.
 */
export function InstallFlow({ connector }: { connector: Detail }) {
  const utils = trpc.useUtils();
  const providers = trpc.integration.providers.useQuery(undefined, { staleTime: 5 * 60_000 });
  const provider = providers.data?.find((p) => p.provider === connector.provider);
  const [projectId, setProjectId] = useState<string | undefined>(connector.integration?.projectId ?? undefined);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [alsoDisconnect, setAlsoDisconnect] = useState(true);

  const refresh = () =>
    Promise.all([
      utils.marketplace.get.invalidate({ slug: connector.slug }),
      utils.marketplace.browse.invalidate(),
      utils.marketplace.listInstalled.invalidate(),
      utils.marketplace.getFeatured.invalidate(),
      utils.integration.list.invalidate(),
    ]);

  const install = trpc.marketplace.install.useMutation({
    onSuccess: async (res) => {
      if (res.next.kind === "connected") toast.success(`${connector.name} installed and connected`);
      else toast.success(`${connector.name} installed. Connect it to start syncing.`);
      await refresh();
    },
  });
  const uninstall = trpc.marketplace.uninstall.useMutation({
    onSuccess: async (res) => {
      setUninstallOpen(false);
      toast.success(res.disconnected ? `${connector.name} uninstalled and disconnected` : `${connector.name} uninstalled`);
      await refresh();
    },
  });

  const installed = !!connector.install;
  const connected = connector.integration?.status === "CONNECTED";
  const projectFieldId = `install-${connector.slug}-project`;

  if (!connector.canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        {installed ? "Installed in this workspace." : "Only workspace owners and admins can install connectors."}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {installed && connected ? (
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
          Installed and connected.{" "}
          <Link href="/integrations" className="text-primary underline-offset-4 hover:underline">
            Manage in Integrations
          </Link>
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={projectFieldId}>Target project</Label>
            <ProjectSelect id={projectFieldId} value={projectId} onChange={setProjectId} />
            <p className="text-xs text-muted-foreground">Synced records become documents in this project.</p>
          </div>
          {!installed ? (
            <Button onClick={() => projectId && install.mutate({ slug: connector.slug, projectId })} disabled={!projectId || install.isPending}>
              {install.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Install {connector.name}
            </Button>
          ) : providers.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading connection options…</p>
          ) : provider ? (
            <div className="space-y-2 rounded-md border p-4">
              <p className="text-sm font-medium">Connect {connector.name}</p>
              {provider.auth === "apiKey" ? (
                <ApiKeyConnectForm provider={provider} projectId={projectId} idPrefix={`install-${connector.slug}`} onConnected={() => void refresh()} />
              ) : (
                <OAuthStartForm provider={provider} projectId={projectId} idPrefix={`install-${connector.slug}`} />
              )}
            </div>
          ) : (
            <p className="text-sm text-destructive">This connector can&apos;t be connected right now.</p>
          )}
        </>
      )}

      {installed && (
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setUninstallOpen(true)}>
          <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
          Uninstall
        </Button>
      )}

      <Dialog open={uninstallOpen} onOpenChange={setUninstallOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall {connector.name}?</DialogTitle>
            <DialogDescription>The connector is removed from this workspace. Documents already synced stay in their projects.</DialogDescription>
          </DialogHeader>
          {connector.integration && connector.integration.status !== "DISCONNECTED" && (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <Label htmlFor="uninstall-disconnect" className="text-sm">
                Also disconnect the integration and delete its credentials
              </Label>
              <Switch id="uninstall-disconnect" checked={alsoDisconnect} onCheckedChange={setAlsoDisconnect} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setUninstallOpen(false)} disabled={uninstall.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => uninstall.mutate({ slug: connector.slug, disconnect: alsoDisconnect })} disabled={uninstall.isPending}>
              {uninstall.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
