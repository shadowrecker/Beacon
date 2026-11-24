"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "./native-select";

const STORAGE_KEY = "beacon.voice.projectId";

function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable (private mode): the choice just isn't remembered */
  }
}

/** The selected project for recordings, remembered per browser. Falls back to the first project. */
export function useVoiceProject(): {
  projectId: string | undefined;
  setProjectId: (id: string) => void;
  projects: Array<{ id: string; name: string }>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const query = trpc.project.list.useQuery({ limit: 100 });
  const projects = (query.data?.items ?? []).map((p) => ({ id: p.id, name: p.name }));
  const [projectId, setProjectIdState] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (projects.length === 0) return;
    if (projectId && projects.some((p) => p.id === projectId)) return;
    const stored = readStored();
    setProjectIdState(stored && projects.some((p) => p.id === stored) ? stored : projects[0].id);
  }, [projects, projectId]);

  return {
    projectId,
    setProjectId: (id) => {
      setProjectIdState(id);
      writeStored(id);
    },
    projects,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

export function ProjectPicker({
  id,
  value,
  onChange,
  projects,
  isLoading,
  isError,
  onRetry,
  label = "Project",
  allowNone,
}: {
  id: string;
  value: string | undefined;
  onChange: (id: string) => void;
  projects: Array<{ id: string; name: string }>;
  isLoading: boolean;
  isError: boolean;
  onRetry?: () => void;
  label?: string;
  /** Offer a "No project" option (value ""). */
  allowNone?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load projects.{" "}
          {onRetry && (
            <button type="button" className="underline" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      ) : !isLoading && projects.length === 0 && !allowNone ? (
        <p className="text-sm text-muted-foreground">Create a project first: recordings are saved into a project.</p>
      ) : (
        <NativeSelect id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={isLoading}>
          {isLoading && <option value="">Loading projects…</option>}
          {allowNone && <option value="">No project (decide later)</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}
