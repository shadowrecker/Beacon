"use client";

import { useParams } from "next/navigation";
import { SynthesisWorkspace } from "@/components/synthesis/synthesis-workspace";
import { trpc } from "@/lib/trpc/client";

export default function SynthesisPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = trpc.project.getById.useQuery({ id: projectId });
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Synthesis</h2>
        <p className="text-sm text-muted-foreground">Recurring themes across this project&apos;s research, each backed by verbatim customer quotes.</p>
      </div>
      <SynthesisWorkspace
        projectId={projectId}
        canRun={project.data?.permissions.runAI ?? false}
        readyDocuments={project.data?.counts.readyDocuments ?? 0}
      />
    </div>
  );
}
