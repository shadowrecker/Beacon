/**
 * Gap analysis: compares a project's latest synthesis themes with a roadmap.
 *
 * The model sees short reference keys (T1…, R1…) instead of database IDs, so it
 * can never choose or invent an ID; references are mapped back and anything it
 * returns that isn't in the input is dropped (and counted). Inputs are bounded:
 * at most MAX_THEMES themes and MAX_ITEMS roadmap items, with truncated text,
 * and the skipped counts are recorded in the output.
 */
import { z } from "zod";
import type { RoadmapItemPriority, RoadmapItemStatus } from "@prisma/client";
import { generateObject } from "@/server/ai/client";
import { untrusted, UNTRUSTED_DATA_POLICY } from "@/server/ai/untrusted";
import type { ThemeSummary } from "@/server/synthesis/queries";

export const MAX_THEMES = 40;
export const MAX_ITEMS = 300;

export interface GapRoadmapItem {
  id: string;
  title: string;
  description: string | null;
  status: RoadmapItemStatus;
  priority: RoadmapItemPriority;
  quarter: string | null;
}

/** What the model returns (loose; normalized below). */
const llmSchema = z.object({
  covered: z.array(z.object({ theme: z.string(), items: z.array(z.string()), rationale: z.string() })),
  partial: z.array(
    z.object({ theme: z.string(), items: z.array(z.string()), rationale: z.string(), missingAspects: z.string() })
  ),
  missing: z.array(
    z.object({
      theme: z.string(),
      rationale: z.string(),
      suggestedTitle: z.string(),
      suggestedDescription: z.string(),
    })
  ),
  recommendations: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      themes: z.array(z.string()),
      priority: z.enum(["P0", "P1", "P2", "P3"]),
    })
  ),
  summary: z.string(),
});

const themeEvidence = z.object({
  themeId: z.string(),
  themeName: z.string(),
  sentiment: z.string(),
  evidenceCount: z.number().int(),
  sampleQuotes: z.array(z.string()),
});
const itemRef = z.object({ id: z.string(), title: z.string(), status: z.string() });

/** Stored shape of GapAnalysis.output (also what the UI renders). */
export const gapOutputSchema = z.object({
  version: z.literal(1),
  synthesisId: z.string(),
  summary: z.string(),
  covered: z.array(themeEvidence.extend({ roadmapItems: z.array(itemRef), rationale: z.string() })),
  partial: z.array(
    themeEvidence.extend({ roadmapItems: z.array(itemRef), rationale: z.string(), missingAspects: z.string() })
  ),
  missing: z.array(
    themeEvidence.extend({
      rationale: z.string(),
      suggestedItem: z.object({ title: z.string(), description: z.string() }),
    })
  ),
  recommendations: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      priority: z.enum(["P0", "P1", "P2", "P3"]),
      themeIds: z.array(z.string()),
    })
  ),
  unclassifiedThemeIds: z.array(z.string()),
  stats: z.object({
    themeCount: z.number().int(),
    roadmapItemCount: z.number().int(),
    covered: z.number().int(),
    partial: z.number().int(),
    missing: z.number().int(),
  }),
  skipped: z.object({ themes: z.number().int(), roadmapItems: z.number().int(), invalidReferences: z.number().int() }),
});
export type GapOutput = z.infer<typeof gapOutputSchema>;

export interface EvidenceDensity {
  covered: number;
  partial: number;
  missing: number;
  byTheme: Record<string, number>;
}

const SYSTEM = `You are a product strategy analyst. You compare customer-evidenced themes against a product roadmap and classify every theme exactly once:
- "covered": one or more roadmap items fully address the theme.
- "partial": roadmap items touch the theme but leave important aspects unaddressed (say which).
- "missing": nothing on the roadmap addresses the theme; suggest a roadmap item for it.
Refer to themes only by their keys (T1, T2, …) and roadmap items only by their keys (R1, R2, …) exactly as given. Never invent keys. Cancelled items do not cover a theme.
Then give up to 5 prioritized recommendations (P0 = most urgent), each referencing the theme keys it addresses, and a 2-4 sentence summary.

${UNTRUSTED_DATA_POLICY}`;

function cut(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const PRIORITY_RANK: Record<RoadmapItemPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const STATUS_RANK: Record<RoadmapItemStatus, number> = { IN_PROGRESS: 0, PLANNED: 1, COMPLETED: 2, CANCELLED: 3 };

/** Choose which items fit in the prompt: active work first, then by priority. */
export function selectItems(items: GapRoadmapItem[], max = MAX_ITEMS): { kept: GapRoadmapItem[]; skipped: number } {
  const sorted = [...items].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
  );
  return { kept: sorted.slice(0, max), skipped: Math.max(0, sorted.length - max) };
}

export async function analyzeGaps(input: {
  orgId: string;
  projectId: string;
  synthesisId: string;
  themes: ThemeSummary[];
  items: GapRoadmapItem[];
  /** Themes beyond MAX_THEMES that the caller didn't load. */
  skippedThemes?: number;
}): Promise<{ output: GapOutput; evidenceDensity: EvidenceDensity }> {
  const themes = input.themes.slice(0, MAX_THEMES);
  const skippedThemes = (input.skippedThemes ?? 0) + Math.max(0, input.themes.length - MAX_THEMES);
  const { kept: items, skipped: skippedItems } = selectItems(input.items);

  const themeByRef = new Map(themes.map((t, i) => [`T${i + 1}`, t]));
  const itemByRef = new Map(items.map((it, i) => [`R${i + 1}`, it]));

  const themeBlock = untrusted(
    "synthesis themes",
    themes
      .map((t, i) => {
        const quotes = t.sampleQuotes.slice(0, 2).map((q) => `    quote: "${cut(q, 280)}"`).join("\n");
        return `T${i + 1}: ${cut(t.name, 120)} (sentiment ${t.sentiment}, ${t.citationCount} citations)\n    ${cut(t.description, 500)}${quotes ? `\n${quotes}` : ""}`;
      })
      .join("\n")
  );
  const itemBlock = items.length
    ? untrusted(
        "roadmap items",
        items
          .map(
            (it, i) =>
              `R${i + 1}: [${it.status}, ${it.priority}${it.quarter ? `, ${cut(it.quarter, 30)}` : ""}] ${cut(it.title, 160)}${it.description ? ` | ${cut(it.description, 260)}` : ""}`
          )
          .join("\n")
      )
    : "(the roadmap has no items)";

  const prompt = `Customer themes (${themes.length}):\n${themeBlock}\n\nRoadmap items (${items.length}):\n${itemBlock}\n\nClassify every theme key exactly once as covered, partial or missing.`;

  const raw = await generateObject({
    feature: "roadmap.gap_analysis",
    orgId: input.orgId,
    projectId: input.projectId,
    system: SYSTEM,
    prompt,
    schema: llmSchema,
    effort: "medium",
    maxTokens: 12_000,
  });

  let invalid = 0;
  const classified = new Set<string>();
  const takeTheme = (ref: string): ThemeSummary | null => {
    const theme = themeByRef.get(ref.trim().toUpperCase());
    if (!theme) {
      invalid++;
      return null;
    }
    if (classified.has(theme.id)) return null; // first classification wins
    classified.add(theme.id);
    return theme;
  };
  const mapItems = (refs: string[]) => {
    const out: Array<z.infer<typeof itemRef>> = [];
    const seen = new Set<string>();
    for (const ref of refs.slice(0, 20)) {
      const it = itemByRef.get(ref.trim().toUpperCase());
      if (!it) {
        invalid++;
        continue;
      }
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({ id: it.id, title: it.title, status: it.status });
    }
    return out;
  };
  const evidence = (t: ThemeSummary) => ({
    themeId: t.id,
    themeName: t.name,
    sentiment: t.sentiment,
    evidenceCount: t.citationCount,
    sampleQuotes: t.sampleQuotes.slice(0, 2).map((q) => cut(q, 400)),
  });

  const covered: GapOutput["covered"] = [];
  for (const c of raw.covered) {
    const t = takeTheme(c.theme);
    if (!t) continue;
    const roadmapItems = mapItems(c.items).filter((i) => i.status !== "CANCELLED");
    if (roadmapItems.length === 0) {
      // A theme can't be "covered" by nothing; treat as missing without a suggestion.
      classified.delete(t.id);
      continue;
    }
    covered.push({ ...evidence(t), roadmapItems, rationale: cut(c.rationale, 600) });
  }
  const partial: GapOutput["partial"] = [];
  for (const p of raw.partial) {
    const t = takeTheme(p.theme);
    if (!t) continue;
    partial.push({
      ...evidence(t),
      roadmapItems: mapItems(p.items),
      rationale: cut(p.rationale, 600),
      missingAspects: cut(p.missingAspects, 600),
    });
  }
  const missing: GapOutput["missing"] = [];
  for (const m of raw.missing) {
    const t = takeTheme(m.theme);
    if (!t) continue;
    missing.push({
      ...evidence(t),
      rationale: cut(m.rationale, 600),
      suggestedItem: { title: cut(m.suggestedTitle, 200), description: cut(m.suggestedDescription, 800) },
    });
  }
  const recommendations: GapOutput["recommendations"] = raw.recommendations.slice(0, 5).map((r) => {
    const themeIds: string[] = [];
    for (const ref of r.themes.slice(0, 10)) {
      const t = themeByRef.get(ref.trim().toUpperCase());
      if (!t) invalid++;
      else if (!themeIds.includes(t.id)) themeIds.push(t.id);
    }
    return { title: cut(r.title, 200), description: cut(r.description, 1_000), priority: r.priority, themeIds };
  });
  const unclassifiedThemeIds = themes.filter((t) => !classified.has(t.id)).map((t) => t.id);

  const output = gapOutputSchema.parse({
    version: 1,
    synthesisId: input.synthesisId,
    summary: cut(raw.summary, 1_500),
    covered,
    partial,
    missing,
    recommendations,
    unclassifiedThemeIds,
    stats: {
      themeCount: themes.length,
      roadmapItemCount: items.length,
      covered: covered.length,
      partial: partial.length,
      missing: missing.length,
    },
    skipped: { themes: skippedThemes, roadmapItems: skippedItems, invalidReferences: invalid },
  });

  const sum = (rows: Array<{ evidenceCount: number }>) => rows.reduce((s, r) => s + r.evidenceCount, 0);
  const evidenceDensity: EvidenceDensity = {
    covered: sum(covered),
    partial: sum(partial),
    missing: sum(missing),
    byTheme: Object.fromEntries(themes.map((t) => [t.id, t.citationCount])),
  };
  return { output, evidenceDensity };
}
