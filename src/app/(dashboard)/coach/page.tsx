"use client";

import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingState } from "@/components/ui/states";
import { ActivityAnalysis } from "@/components/coach/activity-analysis";
import { CoachPanel } from "@/components/coach/coach-panel";
import { CoachingHistory } from "@/components/coach/coaching-history";

const ALL = "__all__";

function CoachView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const projectId = params.get("project") ?? undefined;
  const projects = trpc.project.list.useQuery({ limit: 100 });
  const analysis = trpc.coach.getActivityAnalysis.useQuery({ projectId: projectId ?? "" }, { enabled: !!projectId });
  const items = projects.data?.items ?? [];
  const selectedKnown = !projectId || items.some((p) => p.id === projectId);

  const select = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) next.delete("project");
    else next.set("project", value);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="AI coach" description="Specific, evidence-based coaching on how your team turns feedback into decisions." />
      <div className="w-full max-w-sm space-y-1.5">
        <Label htmlFor="coach-project">Project</Label>
        <Select value={projectId ?? ALL} onValueChange={select} disabled={projects.isLoading}>
          <SelectTrigger id="coach-project">
            <SelectValue placeholder="All projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {items.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
            {projectId && !selectedKnown && <SelectItem value={projectId}>Current project</SelectItem>}
          </SelectContent>
        </Select>
        {projects.isError && <p className="text-sm text-destructive">Couldn&apos;t load projects: {projects.error.message}</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-4 lg:col-span-2" aria-labelledby="coach-insights">
          <h2 id="coach-insights" className="text-lg font-semibold">
            Insights
          </h2>
          <CoachPanel key={projectId ?? ALL} projectId={projectId} canRequest={analysis.data?.canRequestCoaching ?? false} />
        </section>
        <div className="space-y-6">
          {projectId && <ActivityAnalysis projectId={projectId} />}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Coaching history</CardTitle>
            </CardHeader>
            <CardContent>
              <CoachingHistory projectId={projectId} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function CoachPage() {
  return (
    <Suspense fallback={<LoadingState rows={4} label="Loading coach" />}>
      <CoachView />
    </Suspense>
  );
}
