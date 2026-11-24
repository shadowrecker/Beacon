/**
 * LLM classification of new competitor page sections.
 *
 * Page text is third-party content: it reaches the model only inside
 * untrusted() blocks, under UNTRUSTED_DATA_POLICY. The model's output is
 * treated as untrusted too: it can only reference sections by index, its enum
 * values are schema-checked, its text is length-capped, and it never supplies
 * URLs (the source URL is the page we fetched).
 */
import type { CompetitorUpdateType, Sentiment } from "@prisma/client";
import { z } from "zod";
import { generateObject } from "../client";
import { UNTRUSTED_DATA_POLICY, untrusted } from "../untrusted";
import type { Candidate } from "./scanner";

export const classificationSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      relevant: z.boolean(),
      type: z.enum(["CHANGELOG", "PRICING", "FEATURE", "PRESS"]),
      title: z.string(),
      summary: z.string(),
      sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"]),
      significance: z.enum(["low", "medium", "high"]),
    })
  ),
});

export interface ClassifiedUpdate {
  candidate: Candidate;
  relevant: boolean;
  type: CompetitorUpdateType;
  title: string;
  summary: string;
  sentiment: Sentiment;
  significance: "low" | "medium" | "high";
}

const SYSTEM = `You monitor competitors' public websites for a product team.

You receive numbered sections of text taken from a competitor's homepage, changelog, blog/news and pricing pages. For each section decide:
- relevant: true only if it describes a concrete product change, new feature or launch, pricing or packaging change, or a notable company announcement (funding, acquisition, partnership). Marketing filler, navigation, legal text, cookie notices, testimonials and generic positioning are not relevant.
- type: CHANGELOG (release notes), FEATURE (a capability or launch), PRICING (prices, plans, limits), or PRESS (company news).
- title: a short factual headline (max 12 words).
- summary: 1-3 plain sentences stating what changed and why it may matter to a competing product team. No speculation beyond the text.
- sentiment: how the change is likely to land with the competitor's customers.
- significance: high for major launches or price changes, medium for notable improvements, low for minor fixes.

Return exactly one item per section, using the section's index.

${UNTRUSTED_DATA_POLICY}`;

const MAX_PROMPT_CHARS = 60_000;

export async function classifyCandidates(
  ctx: { orgId: string; competitorName: string },
  candidates: Candidate[]
): Promise<ClassifiedUpdate[]> {
  if (candidates.length === 0) return [];
  const blocks: string[] = [];
  let size = 0;
  const included: Candidate[] = [];
  for (const [i, c] of candidates.entries()) {
    const body = untrusted(`${ctx.competitorName} ${new URL(c.pageUrl).pathname}`, `${c.heading ? `${c.heading}\n\n` : ""}${c.text}`);
    if (size + body.length > MAX_PROMPT_CHARS && included.length > 0) break;
    blocks.push(`Section ${i} (page type: ${c.pageKind.toLowerCase()})\n${body}`);
    included.push(c);
    size += body.length;
  }

  const result = await generateObject({
    feature: "competitive.classify",
    orgId: ctx.orgId,
    system: SYSTEM,
    prompt: `Competitor: ${ctx.competitorName.slice(0, 120)}\n\n${blocks.join("\n\n")}`,
    schema: classificationSchema,
    tier: "bulk",
    maxTokens: 4_000,
  });

  const out: ClassifiedUpdate[] = [];
  const used = new Set<number>();
  for (const item of result.items) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= included.length || used.has(item.index)) continue;
    used.add(item.index);
    out.push({
      candidate: included[item.index],
      relevant: item.relevant,
      type: item.type,
      title: item.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Website update",
      summary: item.summary.trim().slice(0, 2_000),
      sentiment: item.sentiment,
      significance: item.significance,
    });
  }
  return out;
}
