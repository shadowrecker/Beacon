"use client";

import { Suspense, useEffect, useId, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { PresentationList } from "@/components/presentations/presentation-list";
import { trpc } from "@/lib/trpc";

function PresentationsView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectId = useId();
  const requested = searchParams.get("project");
  const projects = trpc.project.list.useQuery({ limit: 100 });
  const items = useMemo(() => projects.data?.items ?? [], [projects.data]);
  const selected = items.find((p) => p.id === requested) ?? null;

  // Keep the selection in the URL; default to the most recently updated project.
  useEffect(() => {
    if (!projects.data || items.length === 0 || selected) return;
    router.replace(`${pathname}?project=${encodeURIComponent(items[0].id)}`);
  }, [projects.data, items, selected, pathname, router]);

  const selectProject = (id: string) => router.replace(`${pathname}?project=${encodeURIComponent(id)}`);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Presentations"
        description="Generate stakeholder decks from your research, recommendations and outcomes"
        actions={
          selected ? (
            <Button asChild className="gap-2">
              <Link href={`/presentations/new?project=${encodeURIComponent(selected.id)}`}>
                <Plus className="h-4 w-4" aria-hidden />
                New presentation
              </Link>
            </Button>
          ) : undefined
        }
      />

      {projects.isLoading ? (
        <LoadingState rows={3} label="Loading projects" />
      ) : projects.isError ? (
        <ErrorState message={projects.error.message} onRetry={() => void projects.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create a project and add customer feedback, then generate presentations from it."
          action={
            <Button asChild variant="outline">
              <Link href="/projects">Go to projects</Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="max-w-sm space-y-2">
            <Label htmlFor={selectId}>Project</Label>
            <Select value={selected?.id ?? ""} onValueChange={selectProject}>
              <SelectTrigger id={selectId}>
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {items.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.counts.recommendations} recommendation{p.counts.recommendations === 1 ? "" : "s"})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selected ? <PresentationList projectId={selected.id} /> : <LoadingState rows={2} />}
        </div>
      )}
    </div>
  );
}

export default function PresentationsPage() {
  return (
    <Suspense fallback={<LoadingState rows={3} />}>
      <PresentationsView />
    </Suspense>
  );
}
