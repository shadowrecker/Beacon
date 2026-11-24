"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ApiKeyConnectForm, OAuthStartForm } from "./credential-form";
import { ProjectSelect } from "./project-select";
import type { ProviderInfo } from "./types";

interface ConnectDialogProps {
  provider: ProviderInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected target project (e.g. when reconnecting). */
  defaultProjectId?: string;
}

/** Connect (or reconnect) a provider: choose the target project, then OAuth or API token. */
export function ConnectDialog({ provider, open, onOpenChange, defaultProjectId }: ConnectDialogProps) {
  const [projectId, setProjectId] = useState<string | undefined>(defaultProjectId);
  const projectFieldId = `connect-${provider.provider.toLowerCase()}-project`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {provider.name}</DialogTitle>
          <DialogDescription>
            {provider.syncs}. Records become documents in the project you choose.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor={projectFieldId}>Target project</Label>
            <ProjectSelect id={projectFieldId} value={projectId} onChange={setProjectId} />
          </div>
          {provider.auth === "apiKey" ? (
            <ApiKeyConnectForm provider={provider} projectId={projectId} onConnected={() => onOpenChange(false)} idPrefix="connect-dialog" />
          ) : (
            <OAuthStartForm provider={provider} projectId={projectId} idPrefix="connect-dialog" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
