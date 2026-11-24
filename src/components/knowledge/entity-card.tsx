"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { colorFor, typeLabel } from "./constants";

export interface EntitySummary {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
  description?: string | null;
  relationCount?: number;
}

export function EntityTypeBadge({ type }: { type: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-medium">
      <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: colorFor(type) }} aria-hidden />
      {typeLabel(type)}
    </Badge>
  );
}

/** Compact entity row. Renders a button when `onSelect` is given, otherwise a link to the entity page. */
export function EntityCard({ entity, selected, onSelect }: { entity: EntitySummary; selected?: boolean; onSelect?: (id: string) => void }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium leading-tight">{entity.name}</span>
        <EntityTypeBadge type={entity.type} />
      </div>
      {entity.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entity.description}</p>}
      <p className="mt-1 text-xs text-muted-foreground">
        {entity.mentionCount} mention{entity.mentionCount === 1 ? "" : "s"}
        {entity.relationCount !== undefined && ` · ${entity.relationCount} relation${entity.relationCount === 1 ? "" : "s"}`}
      </p>
    </>
  );
  const className = cn(
    "block w-full rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
    selected && "border-blue-500 bg-blue-50/60 dark:bg-blue-950/30"
  );
  if (onSelect) {
    return (
      <button type="button" className={className} aria-pressed={selected} onClick={() => onSelect(entity.id)}>
        {body}
      </button>
    );
  }
  return (
    <Link href={`/knowledge/${entity.id}`} className={className}>
      {body}
    </Link>
  );
}
