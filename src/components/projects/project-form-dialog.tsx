"use client";

/**
 * Create or rename a project. In "create" mode the project is created in the
 * active workspace; in "edit" mode name and description are updated.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc/client";

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;

interface ProjectFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this project; otherwise it creates one. */
  project?: { id: string; name: string; description: string | null };
}

export function ProjectFormDialog({ open, onOpenChange, project }: ProjectFormDialogProps) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(project?.name ?? "");
      setDescription(project?.description ?? "");
      setError(null);
    }
  }, [open, project]);

  const create = trpc.project.create.useMutation({
    meta: { silent: true },
    onSuccess: async (created) => {
      await utils.project.list.invalidate();
      toast.success("Project created");
      onOpenChange(false);
      router.push(`/projects/${created.id}`);
    },
    onError: (err) => setError(err.message),
  });
  const update = trpc.project.update.useMutation({
    meta: { silent: true },
    onSuccess: async () => {
      await Promise.all([utils.project.list.invalidate(), utils.project.getById.invalidate({ id: project?.id ?? "" })]);
      toast.success("Project updated");
      onOpenChange(false);
    },
    onError: (err) => setError(err.message),
  });
  const pending = create.isPending || update.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Project name is required");
      return;
    }
    setError(null);
    if (project) update.mutate({ id: project.id, name: trimmed, description: description.trim() || null });
    else create.mutate({ name: trimmed, description: description.trim() || undefined });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{project ? "Edit project" : "New project"}</DialogTitle>
            <DialogDescription>
              {project ? "Update the project's name and description." : "A project holds the research, syntheses and recommendations for one product question."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              placeholder="e.g. Self-serve onboarding research"
              autoFocus
              required
              aria-invalid={Boolean(error) && !name.trim()}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={descriptionId}>Description (optional)</Label>
            <Textarea
              id={descriptionId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={DESCRIPTION_MAX}
              rows={3}
              placeholder="What decision is this research meant to inform?"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : project ? "Save changes" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
