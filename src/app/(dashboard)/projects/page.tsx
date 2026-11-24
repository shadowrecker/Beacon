"use client";

import { useMemo, useState } from "react";
import { FolderOpen, Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ProjectCard } from "@/components/projects/project-card";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { trpc } from "@/lib/trpc/client";

export default function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const query = trpc.project.list.useInfiniteQuery({ limit: 24 }, { getNextPageParam: (last) => last.nextCursor });
  const projects = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus className="mr-2 h-4 w-4" aria-hidden /> New project
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Projects" description="Each project collects the research behind one product decision." actions={newButton} />
      {query.isLoading ? (
        <LoadingState rows={3} label="Loading projects" />
      ) : query.isError ? (
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderOpen className="h-8 w-8" />}
          title="No projects yet"
          description="Create a project, add interviews, tickets or recordings, and Beacon will synthesize themes and recommendations from them."
          action={newButton}
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Projects">
            {projects.map((p) => (
              <li key={p.id}>
                <ProjectCard project={p} />
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
