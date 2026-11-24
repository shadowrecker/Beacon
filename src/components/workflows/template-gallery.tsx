"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutTemplate } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingState, QueryState } from "@/components/ui/states";

const selectClass =
  "flex h-10 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-950";

function InstallDialog({ template, onClose }: { template: { id: string; name: string } | null; onClose: () => void }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const uid = useId();
  const [projectId, setProjectId] = useState("");
  const projects = trpc.project.list.useQuery({ limit: 100 }, { enabled: !!template });
  const install = trpc.workflow.installTemplate.useMutation({
    onSuccess: async (res) => {
      toast.success("Template installed. Review it, then enable it.");
      await utils.workflow.list.invalidate();
      onClose();
      router.push(`/workflows/${res.id}`);
    },
  });

  return (
    <Dialog open={!!template} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install “{template?.name}”</DialogTitle>
          <DialogDescription>The workflow is installed disabled so you can review its channels and recipients before it runs.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-project`}>Project</Label>
          {projects.isLoading ? (
            <LoadingState rows={1} label="Loading projects" />
          ) : projects.isError ? (
            <ErrorState message={projects.error.message} onRetry={() => void projects.refetch()} />
          ) : projects.data?.items.length === 0 ? (
            <p className="text-sm text-gray-600">
              Create a project first. <Link href="/projects" className="underline">Go to projects</Link>
            </p>
          ) : (
            <select id={`${uid}-project`} className={selectClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">Choose a project…</option>
              {projects.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!projectId || install.isPending} onClick={() => template && install.mutate({ templateId: template.id, projectId })}>
            {install.isPending ? "Installing…" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TemplateGallery({ canManage }: { canManage: boolean }) {
  const templates = trpc.workflow.listTemplates.useQuery();
  const [installing, setInstalling] = useState<{ id: string; name: string } | null>(null);

  return (
    <>
      <QueryState
        query={templates}
        empty={<EmptyState icon={<LayoutTemplate className="h-8 w-8" />} title="No templates available" />}
      >
        {(list) => (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.map((t) => (
              <li key={t.id}>
                <Card className="flex h-full flex-col">
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="secondary">{t.category}</Badge>
                    </div>
                    <CardTitle className="text-base">{t.name}</CardTitle>
                    <CardDescription>{t.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1 space-y-2 text-sm">
                    <p>
                      <span className="text-gray-500">When:</span> {t.triggerLabel}
                      {t.conditionCount > 0 && ` (${t.conditionCount} condition${t.conditionCount === 1 ? "" : "s"})`}
                    </p>
                    <ul className="flex flex-wrap gap-1" aria-label="Actions">
                      {t.actions.map((a, i) => (
                        <li key={i}>
                          <Badge variant="outline">
                            {a.label}
                            {a.requires && <span className="ml-1 text-gray-500">· needs {a.requires.charAt(0) + a.requires.slice(1).toLowerCase()}</span>}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                  {canManage && (
                    <CardFooter className="gap-2">
                      <Button size="sm" onClick={() => setInstalling({ id: t.id, name: t.name })}>
                        Install
                      </Button>
                      <Button size="sm" variant="outline" asChild>
                        <Link href={`/workflows/new?template=${encodeURIComponent(t.id)}`}>Customize</Link>
                      </Button>
                    </CardFooter>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <InstallDialog template={installing} onClose={() => setInstalling(null)} />
    </>
  );
}
