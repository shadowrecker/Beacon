"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { DeleteProjectDialog } from "@/components/projects/delete-project-dialog";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { ProjectTabs } from "@/components/projects/project-tabs";
import { trpc } from "@/lib/trpc/client";

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const project = trpc.project.getById.useQuery({ id: projectId });
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (project.isError) {
    if (project.error.data?.code === "NOT_FOUND") {
      return (
        <EmptyState
          title="Project not found"
          description="It may have been deleted, or it belongs to a workspace you're not a member of. Check the workspace switcher."
          action={
            <Button asChild variant="outline">
              <Link href="/projects">Back to projects</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState message={project.error.message} onRetry={() => void project.refetch()} />;
  }

  const p = project.data;
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Button asChild variant="ghost" size="icon" className="mt-0.5 flex-shrink-0">
          <Link href="/projects" aria-label="Back to projects">
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          {p ? (
            <>
              <h1 className="break-words text-2xl font-bold text-gray-900 dark:text-white sm:text-3xl">{p.name}</h1>
              {p.description && <p className="mt-1 text-gray-600 dark:text-gray-400">{p.description}</p>}
            </>
          ) : (
            <div className="space-y-2" aria-busy="true" aria-label="Loading project">
              <Skeleton className="h-9 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
        </div>
        {p && (p.permissions.write || p.permissions.delete) && (
          <div className="flex flex-shrink-0 gap-1">
            {p.permissions.write && (
              <Button variant="ghost" size="icon" onClick={() => setEditing(true)} aria-label="Edit project">
                <Pencil className="h-4 w-4" aria-hidden />
              </Button>
            )}
            {p.permissions.delete && (
              <Button variant="ghost" size="icon" onClick={() => setDeleting(true)} aria-label="Delete project">
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            )}
          </div>
        )}
      </div>

      <ProjectTabs projectId={projectId} />
      <div>{children}</div>

      {p && (
        <>
          <ProjectFormDialog open={editing} onOpenChange={setEditing} project={p} />
          <DeleteProjectDialog open={deleting} onOpenChange={setDeleting} project={p} redirectTo="/projects" />
        </>
      )}
    </div>
  );
}
