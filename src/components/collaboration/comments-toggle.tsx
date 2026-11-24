"use client";

import { useId, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { CommentTargetType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { CommentThread } from "./comment-thread";

/**
 * A "Discussion" toggle that expands the comment thread for one target inline.
 * Mounted on recommendations, themes, documents and decisions.
 */
export function CommentsToggle({
  projectId,
  targetType,
  targetId,
  defaultOpen = false,
}: {
  projectId: string;
  targetType: CommentTargetType;
  targetId: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();
  return (
    <div className="mt-4 border-t pt-3">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((o) => !o)}
        className="-ml-2"
      >
        <MessageSquare className="mr-1.5 h-4 w-4" aria-hidden />
        {open ? "Hide discussion" : "Discussion"}
      </Button>
      {open && (
        <div id={regionId} className="mt-3">
          <CommentThread projectId={projectId} targetType={targetType} targetId={targetId} />
        </div>
      )}
    </div>
  );
}
