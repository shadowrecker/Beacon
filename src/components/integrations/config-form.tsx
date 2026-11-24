"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import {
  configToValues,
  FieldInputs,
  toConfigPayload,
  type FieldValues,
} from "./credential-form";
import { ProjectSelect } from "./project-select";
import type { IntegrationRow, ProviderInfo } from "./types";

interface SettingsDialogProps {
  integration: IntegrationRow;
  provider: ProviderInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Target project and provider sync settings for a connected integration. */
export function IntegrationSettingsDialog({
  integration,
  provider,
  open,
  onOpenChange,
}: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{provider.name} settings</DialogTitle>
          <DialogDescription>
            Choose where synced records go and what gets synced.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so background refetches never overwrite edits in progress. */}
        {open && (
          <SettingsForm
            integration={integration}
            provider={provider}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({
  integration,
  provider,
  onDone,
}: {
  integration: IntegrationRow;
  provider: ProviderInfo;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const [projectId, setProjectId] = useState<string | undefined>(
    integration.project?.id
  );
  const [values, setValues] = useState<FieldValues>(() =>
    configToValues(provider.configFields, integration.config)
  );

  const setTarget = trpc.integration.setTargetProject.useMutation();
  const updateConfig = trpc.integration.updateConfig.useMutation();
  const saving = setTarget.isPending || updateConfig.isPending;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (projectId && projectId !== integration.project?.id) {
        await setTarget.mutateAsync({ id: integration.id, projectId });
      }
      if (provider.configFields.length > 0) {
        await updateConfig.mutateAsync({
          id: integration.id,
          config: toConfigPayload(provider.configFields, values),
        });
      }
      await utils.integration.list.invalidate();
      toast.success(`${provider.name} settings saved`);
      onDone();
    } catch {
      // The global mutation handler shows the error.
    }
  };

  const projectFieldId = `settings-${integration.id}-project`;
  const projectHelpId = `${projectFieldId}-help`;
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor={projectFieldId}>Target project</Label>
        <ProjectSelect
          id={projectFieldId}
          value={projectId}
          onChange={setProjectId}
          disabled={saving}
          aria-describedby={projectHelpId}
        />
        <p id={projectHelpId} className="text-xs text-muted-foreground">
          New records go to this project. Records already synced stay where they
          are.
        </p>
      </div>
      {provider.configFields.length > 0 && (
        <FieldInputs
          fields={provider.configFields}
          values={values}
          onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
          idPrefix={`settings-${integration.id}`}
          disabled={saving}
        />
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !projectId}>
          {saving && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
          )}
          Save settings
        </Button>
      </DialogFooter>
    </form>
  );
}
