"use client";

import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { FileText, FolderOpen, Lightbulb, Sparkles, Users, Activity } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { MemberAvatar } from "./member-list";

const SYNTHESIS_LABELS: Record<string, string> = {
  THEMES: "Themes",
  PAIN_POINTS: "Pain points",
  FEATURE_REQUESTS: "Feature requests",
  FULL: "Full synthesis",
};

function Stat({ label, value, icon: Icon, hint }: { label: string; value: number; icon: typeof Users; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <p className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</p>
          <p className="text-sm text-muted-foreground">{label}</p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export function TeamDashboard({ orgId }: { orgId: string }) {
  const dashboard = trpc.team.dashboard.useQuery({ orgId });

  if (dashboard.isLoading) return <LoadingState rows={4} label="Loading dashboard" />;
  if (dashboard.isError) return <ErrorState message={dashboard.error.message} onRetry={() => void dashboard.refetch()} />;
  const d = dashboard.data;
  if (!d) return null;
  const recs = d.counts.recommendationsByStatus;

  return (
    <div className="space-y-6">
      <section aria-label="Organization totals" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Members" value={d.counts.members} icon={Users} />
        <Stat label="Projects" value={d.counts.projects} icon={FolderOpen} />
        <Stat label="Documents" value={d.counts.documents} icon={FileText} hint={`${d.counts.readyDocuments.toLocaleString()} processed`} />
        <Stat label="Completed syntheses" value={d.counts.syntheses} icon={Sparkles} />
        <Stat
          label="Recommendations"
          value={d.counts.recommendations}
          icon={Lightbulb}
          hint={`${recs.ACCEPTED} accepted · ${recs.IMPLEMENTED} implemented`}
        />
        <Stat label="Activity in the last 7 days" value={d.counts.activityLast7Days} icon={Activity} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent syntheses</CardTitle>
            <CardDescription>Latest completed analyses across projects</CardDescription>
          </CardHeader>
          <CardContent>
            {d.recentSyntheses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No completed syntheses yet. Run one from a project&apos;s Synthesis tab.</p>
            ) : (
              <ul className="divide-y">
                {d.recentSyntheses.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link href={`/projects/${s.project.id}/synthesis`} className="truncate font-medium hover:underline">
                        {s.project.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {SYNTHESIS_LABELS[s.type] ?? s.type} · {s.themeCount} {s.themeCount === 1 ? "theme" : "themes"}
                      </p>
                    </div>
                    <time className="flex-shrink-0 text-xs text-muted-foreground" dateTime={new Date(s.completedAt).toISOString()}>
                      {formatDistanceToNow(new Date(s.completedAt), { addSuffix: true })}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top open recommendations</CardTitle>
            <CardDescription>Highest impact first, then confidence</CardDescription>
          </CardHeader>
          <CardContent>
            {d.topRecommendations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open recommendations yet.</p>
            ) : (
              <ul className="divide-y">
                {d.topRecommendations.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link href={`/projects/${r.project.id}/recommendations`} className="line-clamp-1 font-medium hover:underline">
                        {r.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {r.project.name} · {Math.round(r.confidence * 100)}% confidence
                      </p>
                    </div>
                    <Badge variant={r.impact === "HIGH" ? "high" : r.impact === "MEDIUM" ? "medium" : "low"}>
                      {r.impact.charAt(0) + r.impact.slice(1).toLowerCase()}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Most active members</CardTitle>
          <CardDescription>Actions recorded in the last 30 days</CardDescription>
        </CardHeader>
        <CardContent>
          {d.memberActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity in the last 30 days.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {d.memberActivity.map((m) => (
                <li key={m.userId} className="flex items-center gap-3">
                  <MemberAvatar name={m.name} avatarUrl={m.avatarUrl} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.actions} {m.actions === 1 ? "action" : "actions"}
                      {m.lastActiveAt && ` · last ${formatDistanceToNow(new Date(m.lastActiveAt), { addSuffix: true })}`}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
