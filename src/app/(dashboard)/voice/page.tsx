"use client";

import Link from "next/link";
import { format } from "date-fns";
import { Lightbulb, Smartphone } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InsightSummary } from "@/components/voice/insight-summary";
import { ProjectPicker, useVoiceProject } from "@/components/voice/project-picker";
import { QuickCaptureFab } from "@/components/voice/quick-capture-fab";
import { Recorder } from "@/components/voice/recorder";
import { RecordingList } from "@/components/voice/recording-list";
import { trpc } from "@/lib/trpc";

function InsightsTab({ projectId }: { projectId: string }) {
  const insights = trpc.voice.getInsights.useInfiniteQuery({ projectId, limit: 10 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  if (insights.isLoading) return <LoadingState rows={3} label="Loading insights" />;
  if (insights.isError) return <ErrorState message={insights.error.message} onRetry={() => void insights.refetch()} />;
  const items = insights.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return <EmptyState icon={<Lightbulb className="h-8 w-8" />} title="No insights yet" description="Insights appear once a recording in this project has been transcribed and analyzed." />;
  }
  return (
    <div className="space-y-4">
      <ul className="space-y-4">
        {items.map((i) => (
          <li key={i.id}>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  <Link href={`/m/recordings/${i.recording.id}`} className="hover:underline">
                    {i.recording.title || `Recording ${format(new Date(i.recording.recordedAt), "PP p")}`}
                  </Link>
                </CardTitle>
                <p className="text-xs text-muted-foreground">{format(new Date(i.recording.recordedAt), "PP p")}</p>
              </CardHeader>
              <CardContent>
                <InsightSummary insight={i} />
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {insights.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void insights.fetchNextPage()} disabled={insights.isFetchingNextPage}>
            {insights.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function VoicePage() {
  const utils = trpc.useUtils();
  const { projectId, setProjectId, projects, isLoading, isError, refetch } = useVoiceProject();
  const projectName = projects.find((p) => p.id === projectId)?.name;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Voice insights"
        description="Record customer conversations and voice notes. Each recording is transcribed with speaker labels, analyzed, and added to the project as a searchable document."
        actions={
          <Button asChild variant="outline">
            <Link href="/m/record">
              <Smartphone className="mr-2 h-4 w-4" aria-hidden />
              Mobile recorder
            </Link>
          </Button>
        }
      />
      <div className="max-w-sm">
        <ProjectPicker id="voice-project" value={projectId} onChange={setProjectId} projects={projects} isLoading={isLoading} isError={isError} onRetry={refetch} />
      </div>

      {projectId && (
        <div className="grid gap-8 lg:grid-cols-[1fr,360px]">
          <Tabs defaultValue="recordings" className="space-y-4">
            <TabsList>
              <TabsTrigger value="recordings">Recordings</TabsTrigger>
              <TabsTrigger value="insights">Insights</TabsTrigger>
            </TabsList>
            <TabsContent value="recordings">
              <RecordingList projectId={projectId} showDelete />
            </TabsContent>
            <TabsContent value="insights">
              <InsightsTab projectId={projectId} />
            </TabsContent>
          </Tabs>
          <aside>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Record in the browser</CardTitle>
              </CardHeader>
              <CardContent>
                <Recorder projectId={projectId} compact onUploaded={() => void utils.voice.list.invalidate()} />
              </CardContent>
            </Card>
          </aside>
        </div>
      )}
      <QuickCaptureFab projectId={projectId} projectName={projectName} />
    </div>
  );
}
