"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

interface CreateOrgDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new organization after it's created. */
  onCreated: (org: { id: string; name: string }) => void | Promise<void>;
}

export function CreateOrgDialog({ open, onOpenChange, onCreated }: CreateOrgDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = trpc.organization.create.useMutation({ meta: { silent: true } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your organization a name.");
      return;
    }
    try {
      const org = await create.mutateAsync({ name: trimmed });
      toast.success(`Created ${org.name}`);
      setName("");
      await onCreated(org);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the organization.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create an organization</DialogTitle>
            <DialogDescription>
              Organizations let you share projects with your team. You&apos;ll be its owner and can invite people next.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="org-name">Organization name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Acme product team"
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? "org-name-error" : undefined}
            />
            {error && (
              <p id="org-name-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Create organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
