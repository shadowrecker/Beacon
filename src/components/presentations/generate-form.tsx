"use client";

/**
 * New presentation form: project, title, audience, type, theme color and an
 * optional template. Submits presentation.create and opens the new deck.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { trpc } from "@/lib/trpc";
import { TemplateGallery } from "./template-gallery";
import {
  AUDIENCE_OPTIONS,
  DEFAULT_THEME_COLOR,
  isValidThemeColor,
  TYPE_OPTIONS,
  type Audience,
  type PresentationTemplate,
  type PresentationType,
} from "./theme";

const MAX_TITLE = 200;

export function GeneratePresentationForm({ initialProjectId }: { initialProjectId: string | null }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const uid = useId();
  const projects = trpc.project.list.useQuery({ limit: 100 });

  const [projectId, setProjectId] = useState<string>(initialProjectId ?? "");
  const [title, setTitle] = useState("");
  const [audience, setAudience] = useState<Audience>("EXECUTIVE");
  const [type, setType] = useState<PresentationType>("SYNTHESIS_READOUT");
  const [colorText, setColorText] = useState(DEFAULT_THEME_COLOR);
  const [template, setTemplate] = useState<PresentationTemplate | null>(null);
  const [onlyMatching, setOnlyMatching] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Default to the first project once projects load (unless one was preselected).
  useEffect(() => {
    const items = projects.data?.items ?? [];
    if (!items.length) return;
    if (!projectId || !items.some((p) => p.id === projectId)) setProjectId(items[0].id);
  }, [projects.data, projectId]);

  const templates = trpc.presentation.listTemplates.useQuery(onlyMatching ? { audience } : undefined);

  const colorValid = isValidThemeColor(colorText);
  const titleError = !title.trim() ? "A title is required" : title.trim().length > MAX_TITLE ? `At most ${MAX_TITLE} characters` : null;
  const colorError = colorValid ? null : "Use a hex color like #3B82F6";

  const create = trpc.presentation.create.useMutation({
    onSuccess: async (row) => {
      toast.success("Generating your presentation. This usually takes a minute.");
      await utils.presentation.list.invalidate();
      router.push(`/presentations/${row.id}`);
    },
  });

  const chooseTemplate = (t: PresentationTemplate | null) => {
    setTemplate(t);
    if (!t) return;
    setAudience(t.audience);
    setType(t.type);
    if (t.themeColor && isValidThemeColor(t.themeColor)) setColorText(t.themeColor.toUpperCase());
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (titleError || colorError || !projectId) return;
    create.mutate({
      projectId,
      title: title.trim(),
      audience,
      type,
      themeColor: colorText.toUpperCase(),
      ...(template ? { templateId: template.id } : {}),
    });
  };

  if (projects.isLoading) return <LoadingState rows={4} label="Loading projects" />;
  if (projects.isError) return <ErrorState message={projects.error.message} onRetry={() => void projects.refetch()} />;
  const projectItems = projects.data?.items ?? [];
  if (projectItems.length === 0) {
    return <EmptyState title="Create a project first" description="Presentations are generated from a project's research, recommendations and outcomes." />;
  }

  const ids = {
    project: `${uid}-project`,
    title: `${uid}-title`,
    titleError: `${uid}-title-error`,
    audience: `${uid}-audience`,
    type: `${uid}-type`,
    color: `${uid}-color`,
    colorText: `${uid}-color-text`,
    colorError: `${uid}-color-error`,
    matching: `${uid}-matching`,
  };

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Details</CardTitle>
          <CardDescription>Slides are generated from the project&apos;s latest synthesis, top recommendations and tracked outcomes.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={ids.project}>Project</Label>
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger id={ids.project}>
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {projectItems.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor={ids.title}>Title</Label>
            <Input
              id={ids.title}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Q3 customer insights readout"
              aria-invalid={submitted && Boolean(titleError)}
              aria-describedby={submitted && titleError ? ids.titleError : undefined}
              required
            />
            {submitted && titleError && (
              <p id={ids.titleError} className="text-sm text-destructive" role="alert">
                {titleError}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor={ids.audience}>Audience</Label>
            <Select value={audience} onValueChange={(v) => setAudience(v as Audience)}>
              <SelectTrigger id={ids.audience}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIENCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{AUDIENCE_OPTIONS.find((o) => o.value === audience)?.description}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={ids.type}>Presentation type</Label>
            <Select value={type} onValueChange={(v) => setType(v as PresentationType)}>
              <SelectTrigger id={ids.type}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{TYPE_OPTIONS.find((o) => o.value === type)?.description}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={ids.colorText}>Theme color</Label>
            <div className="flex items-center gap-3">
              <input
                id={ids.color}
                type="color"
                aria-label="Pick a theme color"
                value={colorValid ? colorText.toLowerCase() : DEFAULT_THEME_COLOR.toLowerCase()}
                onChange={(e) => setColorText(e.target.value.toUpperCase())}
                className="h-10 w-14 cursor-pointer rounded border border-gray-300 bg-white p-1 dark:border-gray-700 dark:bg-gray-950"
              />
              <Input
                id={ids.colorText}
                value={colorText}
                onChange={(e) => setColorText(e.target.value.trim())}
                maxLength={7}
                className="w-32 font-mono"
                aria-invalid={Boolean(colorError)}
                aria-describedby={colorError ? ids.colorError : undefined}
              />
            </div>
            {colorError && (
              <p id={ids.colorError} className="text-sm text-destructive" role="alert">
                {colorError}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-lg">Template (optional)</CardTitle>
            <CardDescription>A template sets the slide outline. Choosing one also sets its audience, type and color.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Switch id={ids.matching} checked={onlyMatching} onCheckedChange={setOnlyMatching} />
            <Label htmlFor={ids.matching} className="whitespace-nowrap text-sm">
              Only this audience
            </Label>
          </div>
        </CardHeader>
        <CardContent>
          {templates.isLoading ? (
            <LoadingState rows={2} label="Loading templates" />
          ) : templates.isError ? (
            <ErrorState message={templates.error.message} onRetry={() => void templates.refetch()} />
          ) : (
            <TemplateGallery templates={templates.data ?? []} selectedId={template?.id ?? null} onSelect={chooseTemplate} />
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending || !projectId || Boolean(colorError)}>
          {create.isPending ? "Starting…" : "Generate presentation"}
        </Button>
      </div>
    </form>
  );
}
