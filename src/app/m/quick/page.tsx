"use client";

import { useState, type FormEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { NativeSelect } from "@/components/voice/native-select";
import { ProjectPicker, useVoiceProject } from "@/components/voice/project-picker";
import { CAPTURE_TYPES, type CaptureType } from "@/components/voice/quick-capture-fab";

function FileIntoProject({ captureId, projects }: { captureId: string; projects: Array<{ id: string; name: string }> }) {
  const utils = trpc.useUtils();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const sync = trpc.voice.syncToProject.useMutation({
    onSuccess: async () => {
      toast.success("Filed into the project");
      await utils.voice.listQuickCaptures.invalidate();
    },
  });
  if (projects.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={`file-${captureId}`} className="text-xs text-muted-foreground">
          File into
        </Label>
        <NativeSelect id={`file-${captureId}`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button size="sm" onClick={() => sync.mutate({ captureId, projectId })} disabled={!projectId || sync.isPending}>
        {sync.isPending ? "Filing…" : "File"}
      </Button>
    </div>
  );
}

export default function MobileQuickCapturePage() {
  const utils = trpc.useUtils();
  const { projectId, setProjectId, projects, isLoading, isError, refetch } = useVoiceProject();
  const [target, setTarget] = useState<string | null>(null);
  const [type, setType] = useState<CaptureType>("QUICK_THOUGHT");
  const [content, setContent] = useState("");
  const selectedProject = target === null ? projectId : target || undefined;

  const captures = trpc.voice.listQuickCaptures.useInfiniteQuery({ limit: 20 }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const capture = trpc.voice.quickCapture.useMutation({
    onSuccess: async (res) => {
      setContent("");
      toast.success(res.documentId ? "Saved to the project" : "Saved. File it into a project when you're ready.");
      await utils.voice.listQuickCaptures.invalidate();
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    capture.mutate({ projectId: selectedProject, type, content: content.trim() });
  };
  const items = captures.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Quick capture</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="quick-content">Note</Label>
          <Textarea id="quick-content" value={content} onChange={(e) => setContent(e.target.value)} rows={5} maxLength={20_000} placeholder="What did you just hear?" disabled={capture.isPending} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="quick-type">Type</Label>
            <NativeSelect id="quick-type" value={type} onChange={(e) => setType(e.target.value as CaptureType)}>
              {CAPTURE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <ProjectPicker
            id="quick-project"
            label="Project"
            allowNone
            value={selectedProject ?? ""}
            onChange={(v) => {
              setTarget(v);
              if (v) setProjectId(v);
            }}
            projects={projects}
            isLoading={isLoading}
            isError={isError}
            onRetry={refetch}
          />
        </div>
        <Button type="submit" className="w-full" disabled={capture.isPending || !content.trim()}>
          {capture.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
          Save
        </Button>
      </form>

      <section aria-labelledby="captures-heading" className="space-y-3">
        <h2 id="captures-heading" className="font-semibold">
          Your captures
        </h2>
        {captures.isLoading ? (
          <LoadingState rows={2} label="Loading captures" />
        ) : captures.isError ? (
          <ErrorState message={captures.error.message} onRetry={() => void captures.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="Nothing captured yet" description="Notes you save here appear in this list." />
        ) : (
          <ul className="divide-y rounded-lg border">
            {items.map((c) => (
              <li key={c.id} className="space-y-2 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="outline">{CAPTURE_TYPES.find((t) => t.value === c.type)?.label ?? c.type}</Badge>
                  <span>{formatDistanceToNow(new Date(c.createdAt), { addSuffix: true })}</span>
                  {c.syncedToProject && c.project ? <span>· in {c.project.name}</span> : <span>· not filed</span>}
                </div>
                <p className="whitespace-pre-line text-sm">{c.content}</p>
                {!c.syncedToProject && <FileIntoProject captureId={c.id} projects={projects} />}
              </li>
            ))}
          </ul>
        )}
        {captures.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="outline" onClick={() => void captures.fetchNextPage()} disabled={captures.isFetchingNextPage}>
              {captures.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
