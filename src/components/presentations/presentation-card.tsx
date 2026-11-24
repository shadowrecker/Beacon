"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AudienceBadge } from "./audience-badge";
import { PresentationStatusBadge } from "./status-badge";
import { safeThemeColor, typeLabel, type PresentationListItem } from "./theme";

export function PresentationCard({
  presentation: p,
  onRegenerate,
  onDelete,
  regenerating = false,
}: {
  presentation: PresentationListItem;
  onRegenerate: (id: string) => void;
  onDelete: (p: PresentationListItem) => void;
  regenerating?: boolean;
}) {
  return (
    <Card className="flex items-start gap-4 p-4">
      <span className="mt-1 h-10 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: safeThemeColor(p.themeColor) }} aria-hidden />
      <div className="min-w-0 flex-1">
        <Link href={`/presentations/${p.id}`} className="font-semibold text-gray-900 hover:underline dark:text-white">
          {p.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <PresentationStatusBadge status={p.status} />
          <AudienceBadge audience={p.audience} />
          <Badge variant="secondary">{typeLabel(p.type)}</Badge>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Created {formatDistanceToNow(new Date(p.createdAt), { addSuffix: true })}
          {p.user?.name ? ` by ${p.user.name}` : ""}
        </p>
        {p.status === "FAILED" && p.errorMessage && (
          <p className="mt-2 text-sm text-destructive" role="status">
            {p.errorMessage}
          </p>
        )}
      </div>
      <div className="flex flex-shrink-0 gap-1">
        {p.status !== "GENERATING" && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRegenerate(p.id)}
            disabled={regenerating}
            aria-label={`Regenerate ${p.title}`}
            title="Regenerate"
          >
            <RefreshCw className={regenerating ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={() => onDelete(p)} aria-label={`Delete ${p.title}`} title="Delete">
          <Trash2 className="h-4 w-4 text-red-600" aria-hidden />
        </Button>
      </div>
    </Card>
  );
}
