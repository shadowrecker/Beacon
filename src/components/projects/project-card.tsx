"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { FileText, Lightbulb, MoreVertical, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { RouterOutputs } from "@/lib/trpc";
import { DeleteProjectDialog } from "./delete-project-dialog";
import { ProjectFormDialog } from "./project-form-dialog";

export type ProjectListItem = RouterOutputs["project"]["list"]["items"][number];

function Stat({ icon: Icon, value, label }: { icon: typeof FileText; value: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="h-4 w-4" aria-hidden />
      <span>
        <span className="font-medium text-foreground">{value}</span> {label}
      </span>
    </div>
  );
}

export function ProjectCard({ project }: { project: ProjectListItem }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <Card className="relative flex h-full flex-col p-5 transition-shadow focus-within:ring-2 focus-within:ring-blue-500 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-lg font-semibold leading-tight">
          <Link href={`/projects/${project.id}`} className="break-words after:absolute after:inset-0 focus:outline-none">
            {project.name}
          </Link>
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="relative z-10 -mr-2 -mt-2 h-8 w-8" aria-label={`Actions for ${project.name}`}>
              <MoreVertical className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditing(true)}>Rename</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDeleting(true)} className="text-destructive focus:text-destructive">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {project.description ? (
        <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{project.description}</p>
      ) : (
        <p className="mt-2 text-sm italic text-muted-foreground">No description</p>
      )}
      <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 pt-4">
        <Stat icon={FileText} value={project.counts.documents} label={project.counts.documents === 1 ? "document" : "documents"} />
        <Stat icon={Sparkles} value={project.counts.syntheses} label={project.counts.syntheses === 1 ? "synthesis" : "syntheses"} />
        <Stat icon={Lightbulb} value={project.counts.recommendations} label={project.counts.recommendations === 1 ? "recommendation" : "recommendations"} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Updated <time dateTime={new Date(project.updatedAt).toISOString()}>{formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}</time>
      </p>
      <ProjectFormDialog open={editing} onOpenChange={setEditing} project={project} />
      <DeleteProjectDialog open={deleting} onOpenChange={setDeleting} project={project} />
    </Card>
  );
}
