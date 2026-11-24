"use client";

import { useParams } from "next/navigation";
import { RecommendationsWorkspace } from "@/components/recommendations/recommendations-workspace";
import { trpc } from "@/lib/trpc/client";

export default function RecommendationsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = trpc.project.getById.useQuery({ id: projectId });
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Recommendations</h2>
        <p className="text-sm text-muted-foreground">Product actions grounded in the latest synthesis, with the evidence behind each one.</p>
      </div>
      <RecommendationsWorkspace
        projectId={projectId}
        canWrite={project.data?.permissions.write ?? false}
        canRunAI={project.data?.permissions.runAI ?? false}
        hasSynthesis={Boolean(project.data?.latestReadySynthesis)}
      />
    </div>
  );
}
