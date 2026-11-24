"use client";

import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { RouterOutputs } from "@/lib/trpc";
import { PRIORITY_VARIANT, SENTIMENT_VARIANT, STATUS_LABEL, type ItemStatus } from "./labels";

export type GapOutput = NonNullable<NonNullable<RouterOutputs["roadmap"]["getGapAnalysis"]["latest"]>["output"]>;

interface ThemeEvidence {
  themeId: string;
  themeName: string;
  sentiment: string;
  evidenceCount: number;
  sampleQuotes: string[];
}

function ThemeHeader({ theme }: { theme: ThemeEvidence }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h4 className="font-medium text-gray-900 dark:text-white">{theme.themeName}</h4>
      <Badge variant={SENTIMENT_VARIANT[theme.sentiment] ?? "neutral"}>{theme.sentiment.toLowerCase()}</Badge>
      <span className="text-xs text-muted-foreground">
        {theme.evidenceCount} citation{theme.evidenceCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function Quotes({ quotes }: { quotes: string[] }) {
  if (quotes.length === 0) return null;
  return (
    <div className="space-y-1">
      {quotes.map((q, i) => (
        <blockquote key={i} className="border-l-2 border-gray-300 pl-3 text-sm italic text-muted-foreground dark:border-gray-700">
          {q}
        </blockquote>
      ))}
    </div>
  );
}

function LinkedItems({ items }: { items: Array<{ id: string; title: string; status: string }> }) {
  if (items.length === 0) return null;
  return (
    <div className="text-sm">
      <span className="font-medium">Roadmap items: </span>
      <ul className="mt-1 flex flex-wrap gap-2">
        {items.map((it) => (
          <li key={it.id}>
            <Badge variant="outline">
              {it.title} · {STATUS_LABEL[it.status as ItemStatus] ?? it.status}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, icon, count, children }: { title: string; icon: ReactNode; count: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <h3 className="flex items-center gap-2 font-semibold">
        {icon}
        {title} <span className="text-sm font-normal text-muted-foreground">({count})</span>
      </h3>
      {count === 0 ? <p className="text-sm text-muted-foreground">None.</p> : <ul className="space-y-3">{children}</ul>}
    </section>
  );
}

const CARD = {
  green: "rounded-lg border border-green-200 bg-green-50/50 p-4 dark:border-green-900 dark:bg-green-950/20",
  yellow: "rounded-lg border border-yellow-200 bg-yellow-50/50 p-4 dark:border-yellow-900 dark:bg-yellow-950/20",
  red: "rounded-lg border border-red-200 bg-red-50/50 p-4 dark:border-red-900 dark:bg-red-950/20",
};

export function GapAnalysisResult({ output }: { output: GapOutput }) {
  const { stats, skipped } = output;
  const skippedParts = [
    skipped.themes > 0 ? `${skipped.themes} theme${skipped.themes === 1 ? "" : "s"}` : null,
    skipped.roadmapItems > 0 ? `${skipped.roadmapItems} roadmap item${skipped.roadmapItems === 1 ? "" : "s"}` : null,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      {output.summary && <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">{output.summary}</p>}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          { label: "Themes analyzed", value: stats.themeCount },
          { label: "Roadmap items", value: stats.roadmapItemCount },
          { label: "Covered", value: stats.covered },
          { label: "Partially covered", value: stats.partial },
          { label: "Missing", value: stats.missing },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border p-3 dark:border-gray-800">
            <dt className="text-xs text-muted-foreground">{s.label}</dt>
            <dd className="text-2xl font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>

      {(skippedParts.length > 0 || skipped.invalidReferences > 0 || output.unclassifiedThemeIds.length > 0) && (
        <p className="flex items-start gap-2 rounded-lg bg-gray-50 p-3 text-xs text-muted-foreground dark:bg-gray-900">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
          <span>
            {skippedParts.length > 0 && `Not analyzed because of size limits: ${skippedParts.join(" and ")}. `}
            {output.unclassifiedThemeIds.length > 0 &&
              `${output.unclassifiedThemeIds.length} theme${output.unclassifiedThemeIds.length === 1 ? " was" : "s were"} not classified. `}
            {skipped.invalidReferences > 0 && `${skipped.invalidReferences} invalid reference${skipped.invalidReferences === 1 ? " was" : "s were"} ignored.`}
          </span>
        </p>
      )}

      <Section title="Missing from the roadmap" icon={<AlertCircle className="h-5 w-5 text-red-600" aria-hidden />} count={output.missing.length}>
        {output.missing.map((m) => (
          <li key={m.themeId} className={CARD.red}>
            <div className="space-y-2">
              <ThemeHeader theme={m} />
              <p className="text-sm">{m.rationale}</p>
              <Quotes quotes={m.sampleQuotes} />
              {m.suggestedItem.title && (
                <div className="rounded-md bg-white/70 p-3 text-sm dark:bg-gray-950/50">
                  <p className="font-medium">Suggested item: {m.suggestedItem.title}</p>
                  {m.suggestedItem.description && <p className="text-muted-foreground">{m.suggestedItem.description}</p>}
                </div>
              )}
            </div>
          </li>
        ))}
      </Section>

      <Section title="Partially covered" icon={<CircleDashed className="h-5 w-5 text-yellow-600" aria-hidden />} count={output.partial.length}>
        {output.partial.map((p) => (
          <li key={p.themeId} className={CARD.yellow}>
            <div className="space-y-2">
              <ThemeHeader theme={p} />
              <p className="text-sm">{p.rationale}</p>
              {p.missingAspects && (
                <p className="text-sm">
                  <span className="font-medium">Not yet addressed: </span>
                  {p.missingAspects}
                </p>
              )}
              <LinkedItems items={p.roadmapItems} />
              <Quotes quotes={p.sampleQuotes} />
            </div>
          </li>
        ))}
      </Section>

      <Section title="Covered" icon={<CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden />} count={output.covered.length}>
        {output.covered.map((c) => (
          <li key={c.themeId} className={CARD.green}>
            <div className="space-y-2">
              <ThemeHeader theme={c} />
              <p className="text-sm">{c.rationale}</p>
              <LinkedItems items={c.roadmapItems} />
              <Quotes quotes={c.sampleQuotes} />
            </div>
          </li>
        ))}
      </Section>

      {output.recommendations.length > 0 && (
        <section aria-label="Recommendations" className="space-y-3">
          <h3 className="font-semibold">Recommendations</h3>
          <ol className="space-y-2">
            {output.recommendations.map((r, i) => (
              <li key={i} className="rounded-lg border p-4 dark:border-gray-800">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={PRIORITY_VARIANT[r.priority]}>{r.priority}</Badge>
                  <p className="font-medium">{r.title}</p>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
