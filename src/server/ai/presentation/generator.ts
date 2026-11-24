/**
 * Deck generation: bounded project data in, validated slides out.
 *
 * Inputs are capped (themes, recommendations, outcomes and text lengths) and
 * third-party-derived text is wrapped as untrusted. The model returns loosely
 * shaped slides that are normalized to the strict slide schema.
 */
import { z } from "zod";
import type { PresentationAudience, PresentationType, OutcomeStatus, RecommendationImpact, RecommendationStatus } from "@prisma/client";
import { generateObject } from "../client";
import { untrusted } from "../untrusted";
import type { ThemeSummary } from "@/server/synthesis/queries";
import { deckSystemPrompt } from "./prompts";
import { normalizeSlides, SLIDE_LAYOUTS, type Slide } from "./schema";
import type { ResolvedTemplate } from "./templates";

export const MAX_DECK_THEMES = 12;
export const MAX_DECK_RECOMMENDATIONS = 10;
export const MAX_DECK_OUTCOMES = 10;

export interface DeckInput {
  orgId: string;
  projectId: string;
  project: { name: string; description: string | null };
  title: string;
  audience: PresentationAudience;
  type: PresentationType;
  template: ResolvedTemplate | null;
  themes: ThemeSummary[];
  recommendations: Array<{ title: string; description: string; impact: RecommendationImpact; confidence: number; status: RecommendationStatus }>;
  outcomes: Array<{
    title: string;
    status: OutcomeStatus;
    metricName: string | null;
    baselineValue: number | null;
    currentValue: number | null;
    targetValue: number | null;
  }>;
}

const llmSchema = z.object({
  slides: z.array(
    z.object({
      layout: z.enum(SLIDE_LAYOUTS),
      title: z.string(),
      subtitle: z.string(),
      bulletPoints: z.array(z.string()),
      speakerNotes: z.string(),
    })
  ),
});

function cut(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const num = (n: number | null) => (n === null ? "unknown" : String(n));

export function buildDeckPrompt(input: DeckInput): string {
  const themes = input.themes.slice(0, MAX_DECK_THEMES);
  const recs = input.recommendations.slice(0, MAX_DECK_RECOMMENDATIONS);
  const outcomes = input.outcomes.slice(0, MAX_DECK_OUTCOMES);

  const themeText = themes.length
    ? untrusted(
        "synthesis themes",
        themes
          .map(
            (t, i) =>
              `${i + 1}. ${cut(t.name, 120)} (sentiment ${t.sentiment}, confidence ${Math.round(t.confidenceScore * 100)}%, ${t.citationCount} citations): ${cut(t.description, 400)}${t.sampleQuotes.length ? `\n   Quotes: ${t.sampleQuotes.slice(0, 2).map((q) => `"${cut(q, 200)}"`).join(" ")}` : ""}`
          )
          .join("\n")
      )
    : "(no synthesis themes yet)";
  const recText = recs.length
    ? untrusted(
        "recommendations",
        recs
          .map((r, i) => `${i + 1}. [${r.impact} impact, ${Math.round(r.confidence * 100)}% confidence, ${r.status}] ${cut(r.title, 160)}: ${cut(r.description, 400)}`)
          .join("\n")
      )
    : "(no recommendations yet)";
  const outcomeText = outcomes.length
    ? untrusted(
        "outcomes",
        outcomes
          .map(
            (o, i) =>
              `${i + 1}. ${cut(o.title, 160)}: ${o.status}${o.metricName ? `, metric ${cut(o.metricName, 80)} baseline ${num(o.baselineValue)}, current ${num(o.currentValue)}, target ${num(o.targetValue)}` : ""}`
          )
          .join("\n")
      )
    : "(no tracked outcomes yet)";
  const outline = input.template?.outline.length
    ? `Follow this outline from the "${cut(input.template.name, 80)}" template (one slide per entry, in order; adapt titles to the data):\n${input.template.outline
        .slice(0, 20)
        .map((s, i) => `${i + 1}. [${s.contentType === "comparison" ? "content" : s.contentType}] ${cut(s.title, 100)}${s.guidance ? ` (${cut(s.guidance, 300)})` : ""}`)
        .join("\n")}`
    : "Choose an outline that suits the audience and presentation type.";

  return `Deck title: ${untrusted("deck title", cut(input.title, 200))}
Project: ${untrusted("project", `${cut(input.project.name, 120)}${input.project.description ? ` - ${cut(input.project.description, 400)}` : ""}`)}

${outline}

Customer themes (${themes.length} of the latest synthesis):
${themeText}

Recommendations (${recs.length}):
${recText}

Outcomes (${outcomes.length}):
${outcomeText}`;
}

export async function generateDeck(input: DeckInput): Promise<Slide[]> {
  const out = await generateObject({
    feature: "presentation.generate",
    orgId: input.orgId,
    projectId: input.projectId,
    system: deckSystemPrompt(input.audience, input.type),
    prompt: buildDeckPrompt(input),
    schema: llmSchema,
    effort: "medium",
    maxTokens: 12_000,
  });
  const slides = normalizeSlides(out.slides);
  if (slides.length === 0) throw new Error("The model returned no slides");
  return slides;
}
