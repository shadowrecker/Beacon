"use client";

import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc/client";

interface DeleteProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; name: string };
  /** Navigate here after deleting (e.g. back to the project list). */
  redirectTo?: string;
}

export function DeleteProjectDialog({ open, onOpenChange, project, redirectTo }: DeleteProjectDialogProps) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const remove = trpc.project.delete.useMutation({
    onSuccess: async () => {
      await utils.project.list.invalidate();
      toast.success(`Deleted "${project.name}"`);
      onOpenChange(false);
      if (redirectTo) router.push(redirectTo);
    },
  });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete "${project.name}"?`}
      description="This permanently deletes the project with all of its documents, uploaded files, syntheses, recommendations and questions. This can't be undone."
      confirmLabel="Delete project"
      destructive
      pending={remove.isPending}
      onConfirm={() => remove.mutate({ id: project.id })}
    />
  );
}
