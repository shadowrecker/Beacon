"use client";

/**
 * Custom AI settings: terminology, focus areas, tone, output preferences,
 * categories and additional guidance. Validated with the same schema as the
 * server; admins edit, everyone else gets a read-only view. The preview shows
 * the exact organization-context text appended to Beacon's prompts.
 */
import { useEffect, useId, useState, type FormEvent } from "react";
import { Eye, Plus, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorState, LoadingState } from "@/components/ui/states";
import {
  CUSTOM_AI_LIMITS as L,
  customAIConfigSchema,
  INDUSTRY_PRESETS,
  type CustomAIConfigValue,
} from "@/server/ai/custom/schema";

interface Draft {
  industryPreset: string;
  terms: Array<{ key: number; term: string; meaning: string }>;
  focusAreas: Array<{ key: number; value: string }>;
  tone: string;
  outputPreferences: string;
  categories: Array<{ key: number; name: string; description: string }>;
  systemPromptOverride: string;
}

let seq = 1;
const k = () => seq++;

function toDraft(c: CustomAIConfigValue): Draft {
  return {
    industryPreset: c.industryPreset ?? "",
    terms: Object.entries(c.templates.terminology).map(([term, meaning]) => ({ key: k(), term, meaning })),
    focusAreas: c.templates.focusAreas.map((value) => ({ key: k(), value })),
    tone: c.templates.tone,
    outputPreferences: c.templates.outputPreferences,
    categories: c.taxonomy.categories.map((cat) => ({ key: k(), name: cat.name, description: cat.description ?? "" })),
    systemPromptOverride: c.systemPromptOverride ?? "",
  };
}

function fromDraft(d: Draft) {
  return {
    industryPreset: d.industryPreset.trim() || null,
    templates: {
      terminology: Object.fromEntries(d.terms.filter((t) => t.term.trim() || t.meaning.trim()).map((t) => [t.term.trim(), t.meaning.trim()])),
      focusAreas: d.focusAreas.map((f) => f.value.trim()).filter(Boolean),
      tone: d.tone.trim(),
      outputPreferences: d.outputPreferences.trim(),
    },
    taxonomy: {
      categories: d.categories
        .filter((c) => c.name.trim() || c.description.trim())
        .map((c) => ({ name: c.name.trim(), ...(c.description.trim() ? { description: c.description.trim() } : {}) })),
    },
    systemPromptOverride: d.systemPromptOverride.trim() || null,
  };
}

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className={`text-xs tabular-nums ${value.length > max ? "text-red-600" : "text-gray-500"}`}>
      {value.length}/{max}
    </span>
  );
}

export function CustomAIForm() {
  const uid = useId();
  const utils = trpc.useUtils();
  const query = trpc.customAI.get.useQuery();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (query.data && draft === null) setDraft(toDraft(query.data.config));
  }, [query.data, draft]);

  const save = trpc.customAI.update.useMutation({
    onSuccess: async (res) => {
      toast.success("AI settings saved");
      setDraft(toDraft(res.config));
      setPreview(res.addendum);
      await utils.customAI.get.invalidate();
    },
  });
  const previewMutation = trpc.customAI.preview.useMutation({ onSuccess: (res) => setPreview(res.addendum) });

  if (query.isLoading || (query.data && !draft)) return <LoadingState rows={4} label="Loading AI settings" />;
  if (query.isError) return <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />;
  if (!query.data || !draft) return null;
  const canEdit = query.data.canEdit;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  function validated() {
    const parsed = customAIConfigSchema.safeParse(fromDraft(draft!));
    if (!parsed.success) {
      setErrors([...new Set(parsed.error.issues.map((i) => i.message))].slice(0, 8));
      return null;
    }
    const terms = draft!.terms.filter((t) => t.term.trim() || t.meaning.trim());
    const missing = terms.some((t) => !t.term.trim() || !t.meaning.trim());
    const dupes = new Set(terms.map((t) => t.term.trim().toLowerCase())).size !== terms.length;
    const problems = [missing ? "Each term needs a definition" : "", dupes ? "Terms must be unique" : ""].filter(Boolean);
    if (problems.length) {
      setErrors(problems);
      return null;
    }
    setErrors([]);
    return parsed.data;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = validated();
    if (value) save.mutate(value);
  }

  function runPreview() {
    const value = validated();
    if (value) previewMutation.mutate({ sample: value });
  }

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      {!canEdit && (
        <p className="rounded-lg border bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
          You can view these settings. Only workspace owners and admins can change them.
        </p>
      )}
      <fieldset disabled={!canEdit || save.isPending} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Context</CardTitle>
            <CardDescription>Tell Beacon about your market so analyses use the right framing.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <Label htmlFor={`${uid}-industry`}>Industry</Label>
                <Counter value={draft.industryPreset} max={L.industryPreset} />
              </div>
              <Input id={`${uid}-industry`} list={`${uid}-industries`} value={draft.industryPreset} onChange={(e) => set({ industryPreset: e.target.value })} maxLength={L.industryPreset} />
              <datalist id={`${uid}-industries`}>
                {INDUSTRY_PRESETS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between">
                <Label htmlFor={`${uid}-tone`}>Writing tone</Label>
                <Counter value={draft.tone} max={L.tone} />
              </div>
              <Input id={`${uid}-tone`} value={draft.tone} onChange={(e) => set({ tone: e.target.value })} maxLength={L.tone} placeholder="Concise and direct" />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <div className="flex justify-between">
                <Label htmlFor={`${uid}-output`}>Output preferences</Label>
                <Counter value={draft.outputPreferences} max={L.outputPreferences} />
              </div>
              <Textarea id={`${uid}-output`} rows={3} value={draft.outputPreferences} onChange={(e) => set({ outputPreferences: e.target.value })} maxLength={L.outputPreferences} placeholder="Lead with business impact; keep summaries under 100 words." />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Focus areas</CardTitle>
            <CardDescription>Topics Beacon should prioritize (up to {L.focusAreas}).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {draft.focusAreas.map((f, i) => (
              <div key={f.key} className="flex gap-2">
                <Label htmlFor={`${uid}-focus-${f.key}`} className="sr-only">
                  Focus area {i + 1}
                </Label>
                <Input id={`${uid}-focus-${f.key}`} value={f.value} maxLength={L.focusArea} onChange={(e) => set({ focusAreas: draft.focusAreas.map((x) => (x.key === f.key ? { ...x, value: e.target.value } : x)) })} />
                <Button variant="ghost" size="icon" aria-label={`Remove focus area ${i + 1}`} onClick={() => set({ focusAreas: draft.focusAreas.filter((x) => x.key !== f.key) })}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ))}
            {draft.focusAreas.length < L.focusAreas && canEdit && (
              <Button variant="outline" size="sm" onClick={() => set({ focusAreas: [...draft.focusAreas, { key: k(), value: "" }] })}>
                <Plus className="mr-1 h-4 w-4" aria-hidden /> Add focus area
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Terminology</CardTitle>
            <CardDescription>Your own terms and what they mean (up to {L.terminologyEntries}).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {draft.terms.map((t, i) => (
              <div key={t.key} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
                <div>
                  <Label htmlFor={`${uid}-term-${t.key}`} className="sr-only">
                    Term {i + 1}
                  </Label>
                  <Input id={`${uid}-term-${t.key}`} placeholder="Term" value={t.term} maxLength={L.termKey} onChange={(e) => set({ terms: draft.terms.map((x) => (x.key === t.key ? { ...x, term: e.target.value } : x)) })} />
                </div>
                <div>
                  <Label htmlFor={`${uid}-meaning-${t.key}`} className="sr-only">
                    Meaning of term {i + 1}
                  </Label>
                  <Input id={`${uid}-meaning-${t.key}`} placeholder="Meaning" value={t.meaning} maxLength={L.termValue} onChange={(e) => set({ terms: draft.terms.map((x) => (x.key === t.key ? { ...x, meaning: e.target.value } : x)) })} />
                </div>
                <Button variant="ghost" size="icon" aria-label={`Remove term ${i + 1}`} onClick={() => set({ terms: draft.terms.filter((x) => x.key !== t.key) })}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ))}
            {draft.terms.length < L.terminologyEntries && canEdit && (
              <Button variant="outline" size="sm" onClick={() => set({ terms: [...draft.terms, { key: k(), term: "", meaning: "" }] })}>
                <Plus className="mr-1 h-4 w-4" aria-hidden /> Add term
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Categories</CardTitle>
            <CardDescription>Preferred categories when Beacon groups feedback (up to {L.categories}).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {draft.categories.map((c, i) => (
              <div key={c.key} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
                <div>
                  <Label htmlFor={`${uid}-cat-${c.key}`} className="sr-only">
                    Category {i + 1} name
                  </Label>
                  <Input id={`${uid}-cat-${c.key}`} placeholder="Name" value={c.name} maxLength={L.categoryName} onChange={(e) => set({ categories: draft.categories.map((x) => (x.key === c.key ? { ...x, name: e.target.value } : x)) })} />
                </div>
                <div>
                  <Label htmlFor={`${uid}-catdesc-${c.key}`} className="sr-only">
                    Category {i + 1} description
                  </Label>
                  <Input id={`${uid}-catdesc-${c.key}`} placeholder="Description (optional)" value={c.description} maxLength={L.categoryDescription} onChange={(e) => set({ categories: draft.categories.map((x) => (x.key === c.key ? { ...x, description: e.target.value } : x)) })} />
                </div>
                <Button variant="ghost" size="icon" aria-label={`Remove category ${i + 1}`} onClick={() => set({ categories: draft.categories.filter((x) => x.key !== c.key) })}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            ))}
            {draft.categories.length < L.categories && canEdit && (
              <Button variant="outline" size="sm" onClick={() => set({ categories: [...draft.categories, { key: k(), name: "", description: "" }] })}>
                <Plus className="mr-1 h-4 w-4" aria-hidden /> Add category
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Additional guidance</CardTitle>
            <CardDescription>
              Extra instructions added to every AI request as organization context. They adjust focus and wording; they never replace Beacon&apos;s
              built-in instructions, safety rules or output formats.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <div className="flex justify-between">
              <Label htmlFor={`${uid}-guidance`}>Guidance</Label>
              <Counter value={draft.systemPromptOverride} max={L.systemPromptOverride} />
            </div>
            <Textarea id={`${uid}-guidance`} rows={5} value={draft.systemPromptOverride} onChange={(e) => set({ systemPromptOverride: e.target.value })} maxLength={L.systemPromptOverride} />
          </CardContent>
        </Card>
      </fieldset>

      {errors.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 rounded-lg border border-red-300 bg-red-50 p-3 pl-6 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Preview</CardTitle>
          <CardDescription>The organization context appended to Beacon&apos;s prompts for this workspace.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(() => {
            const text = preview === undefined ? query.data.addendum : preview;
            return text ? (
              <pre className="whitespace-pre-wrap rounded-md bg-gray-100 p-3 text-xs dark:bg-gray-900">{text}</pre>
            ) : (
              <p className="text-sm text-gray-500">No customization: Beacon uses its default instructions.</p>
            );
          })()}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={runPreview} disabled={previewMutation.isPending}>
              <Eye className="mr-2 h-4 w-4" aria-hidden />
              {previewMutation.isPending ? "Previewing…" : "Preview changes"}
            </Button>
            {canEdit && (
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save settings"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </form>
  );
}
