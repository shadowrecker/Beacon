"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { FileText, Lightbulb, MessageSquare, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/states";
import { StatusBadge } from "@/components/documents/status-badge";
import { ImpactBadge } from "@/components/recommendations/impact-badge";
import { SYNTHESIS_TYPE_LABEL } from "@/components/synthesis/synthesis-types";
import { trpc } from "@/lib/trpc/client";

function StatCard({ label, value, detail, href, icon: Icon }: { label: string; value: number; detail?: string; href: string; icon: typeof FileText }) {
  return (
    <Card className="relative p-4 focus-within:ring-2 focus-within:ring-blue-500 hover:shadow-md">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden />
        <Link href={href} className="after:absolute after:inset-0 focus:outline-none">
          {label}
        </Link>
      </div>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </Card>
  );
}

function ago(d: Date | string) {
  return formatDistanceToNow(new Date(d), { addSuffix: true });
}

export default function ProjectOverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const project = trpc.project.getById.useQuery({ id: projectId });
  if (!project.data) return <LoadingState rows={3} label="Loading overview" />;
  const p = project.data;
  const base = `/projects/${projectId}`;
  const docDetail = [
    p.counts.readyDocuments ? `${p.counts.readyDocuments} ready` : null,
    p.counts.processingDocuments ? `${p.counts.processingDocuments} processing` : null,
    p.counts.failedDocuments ? `${p.counts.failedDocuments} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const nextStep =
    p.counts.documents === 0
      ? { text: "Start by adding customer research: interviews, call recordings, tickets or notes.", href: `${base}/documents`, cta: "Add documents" }
      : !p.latestReadySynthesis
        ? { text: "Your documents are in. Run a synthesis to find recurring themes.", href: `${base}/synthesis`, cta: "Run a synthesis" }
        : p.counts.recommendations === 0
          ? { text: "Themes are ready. Generate recommendations from them.", href: `${base}/recommendations`, cta: "Generate recommendations" }
          : null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Documents" value={p.counts.documents} detail={docDetail || undefined} href={`${base}/documents`} icon={FileText} />
        <StatCard
          label="Syntheses"
          value={p.counts.syntheses}
          detail={p.latestReadySynthesis ? `${p.latestReadySynthesis.themeCount} themes in the latest` : undefined}
          href={`${base}/synthesis`}
          icon={Sparkles}
        />
        <StatCard label="Recommendations" value={p.counts.recommendations} href={`${base}/recommendations`} icon={Lightbulb} />
        <Card className="flex flex-col justify-between p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" aria-hidden /> Ask
          </div>
          <p className="mt-2 text-sm">Ask a question and get an answer that cites your documents.</p>
          <Button asChild size="sm" variant="outline" className="mt-3 self-start">
            <Link href={`${base}/query`}>Ask a question</Link>
          </Button>
        </Card>
      </div>

      {nextStep && p.permissions.write && (
        <Card className="flex flex-col gap-3 border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">{nextStep.text}</p>
          <Button asChild size="sm">
            <Link href={nextStep.href}>{nextStep.cta}</Link>
          </Button>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <h2 className="font-semibold">Recent documents</h2>
          {p.recent.documents.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No documents yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {p.recent.documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`${base}/documents/${d.id}`} className="min-w-0 truncate hover:underline">
                    {d.title}
                  </Link>
                  <StatusBadge status={d.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="font-semibold">Recent syntheses</h2>
          {p.recent.syntheses.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No syntheses yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {p.recent.syntheses.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`${base}/synthesis`} className="hover:underline">
                    {SYNTHESIS_TYPE_LABEL[s.type]} · {ago(s.createdAt)}
                    {s.status === "READY" ? ` · ${s.themeCount} themes` : ""}
                  </Link>
                  <StatusBadge status={s.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="font-semibold">Latest recommendations</h2>
          {p.recent.recommendations.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No recommendations yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {p.recent.recommendations.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`${base}/recommendations`} className="min-w-0 truncate hover:underline">
                    {r.title}
                  </Link>
                  <ImpactBadge impact={r.impact} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Created {ago(p.createdAt)} · your role: {p.role.toLowerCase()}
      </p>
    </div>
  );
}
