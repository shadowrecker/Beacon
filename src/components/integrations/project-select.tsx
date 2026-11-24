"use client";

import { trpc } from "@/lib/trpc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface ProjectSelectProps {
  id: string;
  value: string | undefined;
  onChange: (projectId: string) => void;
  disabled?: boolean;
  "aria-describedby"?: string;
}

/** Target project picker for synced records (projects in the active workspace). */
export function ProjectSelect({ id, value, onChange, disabled, ...rest }: ProjectSelectProps) {
  const projects = trpc.project.list.useQuery({ limit: 100 });
  const items = projects.data?.items ?? [];

  if (projects.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Couldn&apos;t load projects.{" "}
        <button type="button" className="underline" onClick={() => void projects.refetch()}>
          Try again
        </button>
      </p>
    );
  }
  if (!projects.isLoading && items.length === 0) {
    return <p className="text-sm text-muted-foreground">Create a project first: synced records are stored in a project.</p>;
  }
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled || projects.isLoading}>
      <SelectTrigger id={id} aria-describedby={rest["aria-describedby"]}>
        <SelectValue placeholder={projects.isLoading ? "Loading projects…" : "Choose a project"} />
      </SelectTrigger>
      <SelectContent>
        {items.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
