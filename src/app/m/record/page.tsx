"use client";

import { useRouter } from "next/navigation";
import { ProjectPicker, useVoiceProject } from "@/components/voice/project-picker";
import { Recorder } from "@/components/voice/recorder";

export default function MobileRecordPage() {
  const router = useRouter();
  const { projectId, setProjectId, projects, isLoading, isError, refetch } = useVoiceProject();
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Record</h1>
      <ProjectPicker id="record-project" label="Save to project" value={projectId} onChange={setProjectId} projects={projects} isLoading={isLoading} isError={isError} onRetry={refetch} />
      <Recorder projectId={projectId} onUploaded={(id) => router.push(`/m/recordings/${id}`)} />
      <p className="text-xs text-muted-foreground">
        Let everyone on the call know it&apos;s being recorded. Audio is stored privately and transcribed by Deepgram; you can delete it at any time.
      </p>
    </div>
  );
}
