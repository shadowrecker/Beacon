"use client";

import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";

/** Topbar entry to the coach for the current project, with the count of new insights. */
export function CoachBell({ projectId }: { projectId: string }) {
  const q = trpc.coach.getInsights.useQuery({ projectId, status: "NEW", limit: 1 }, { enabled: !!projectId, refetchInterval: 120_000 });
  const count = q.data?.newCount ?? 0;
  const label = count > 0 ? `Coach insights, ${count} new` : "Coach insights";
  return (
    <Button asChild variant="ghost" size="icon" className="relative">
      <Link href={`/coach?project=${encodeURIComponent(projectId)}`} aria-label={label} title={label}>
        <Lightbulb className="h-5 w-5" aria-hidden />
        {count > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white" aria-hidden>
            {count > 9 ? "9+" : count}
          </span>
        )}
      </Link>
    </Button>
  );
}
