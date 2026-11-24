/**
 * Feature briefs for recommendations.
 *
 * The brief body (problem, stories, requirements, metrics, questions, risks) is
 * model-written from the recommendation and its stored evidence; the evidence
 * appendix and identifiers are assembled server-side from verified citations.
 * Briefs are stored on Recommendation.brief (with briefGeneratedAt) and reused
 * by the handoff exporter.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { generateObject } from "./client";
import { untrusted } from "./untrusted";
import { BRIEF_SYSTEM, FEATURES } from "./prompts";
import type { BriefQuote, FeatureBrief, RecommendationEvidence } from "./types";
import { truncate } from "./utils";

const briefBodySchema = z.object({
  title: z.string(),
  problemStatement: z.string(),
  userStories: z.array(
    z.object({ persona: z.string(), action: z.string(), benefit: z.string(), acceptanceCriteria: z.array(z.string()) })
  ),
  requirements: z.array(
    z.object({ id: z.string(), priority: z.enum(["P0", "P1"]), description: z.string(), acceptanceCriteria: z.array(z.string()) })
  ),
  successMetrics: z.array(z.object({ metric: z.string(), targetValue: z.string(), measuringMethod: z.string() })),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
  impactedSegments: z.array(z.string()),
  expectedImpact: z.enum(["high", "medium", "low"]),
});

/** Schema of a stored brief (validated when read back). */
export const featureBriefSchema = briefBodySchema.extend({
  version: z.literal(1),
  recommendationId: z.string(),
  confidenceLevel: z.number(),
  evidenceAppendix: z.array(
    z.object({
      category: z.string(),
      quotes: z.array(z.object({ text: z.string(), context: z.string(), chunkId: z.string(), documentId: z.string() })),
    })
  ),
  generatedAt: z.string(),
});

const evidenceSchema = z.object({
  themes: z.array(z.object({ id: z.string(), name: z.string() })),
  quotes: z.array(
    z.object({ chunkId: z.string(), documentId: z.string(), documentTitle: z.string(), quote: z.string(), position: z.number().int().optional() })
  ),
  rationale: z.string(),
  modelConfidence: z.number(),
});

export function parseEvidence(value: Prisma.JsonValue | null): RecommendationEvidence | null {
  const parsed = evidenceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseBrief(value: Prisma.JsonValue | null): FeatureBrief | null {
  const parsed = featureBriefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const cap = (items: string[], n: number, len: number) => items.map((s) => truncate(s.trim(), len)).filter(Boolean).slice(0, n);

export interface BriefTarget {
  recommendationId: string;
  projectId: string;
  orgId: string;
}

/**
 * Return the stored brief, or generate and store one (always when `regenerate`).
 * The recommendation is looked up scoped to the (already authorized) project.
 */
export async function getOrGenerateBrief(target: BriefTarget, opts: { regenerate?: boolean } = {}): Promise<{ brief: FeatureBrief; generated: boolean }> {
  const rec = await prisma.recommendation.findFirst({
    where: { id: target.recommendationId, projectId: target.projectId },
    select: { id: true, title: true, description: true, impact: true, confidence: true, segments: true, evidence: true, brief: true },
  });
  if (!rec) throw new Error("Recommendation not found");

  const existing = parseBrief(rec.brief);
  if (existing && !opts.regenerate) return { brief: existing, generated: false };

  const evidence = parseEvidence(rec.evidence);
  const quotes = evidence?.quotes ?? [];
  const prompt = [
    `Recommendation: ${rec.title}`,
    `Impact: ${rec.impact}; confidence ${rec.confidence.toFixed(2)}${rec.segments.length ? `; segments: ${rec.segments.join(", ")}` : ""}`,
    "",
    rec.description,
    evidence?.rationale ? `\nRationale: ${evidence.rationale}` : "",
    evidence?.themes.length ? `\nSupporting themes: ${evidence.themes.map((t) => t.name).join("; ")}` : "",
    quotes.length
      ? `\nCustomer evidence:\n\n${quotes.map((q, i) => untrusted(`evidence:${i + 1}`, `From "${q.documentTitle}": ${q.quote}`)).join("\n\n")}`
      : "\nNo direct customer quotes are attached to this recommendation.",
  ].join("\n");

  const body = await generateObject({
    feature: FEATURES.recommendationsBrief,
    orgId: target.orgId,
    projectId: target.projectId,
    system: BRIEF_SYSTEM,
    prompt: truncate(prompt, 40_000),
    schema: briefBodySchema,
    effort: "medium",
    maxTokens: 12_000,
  });

  const appendixQuotes: BriefQuote[] = quotes.map((q) => ({
    text: q.quote,
    context: q.documentTitle,
    chunkId: q.chunkId,
    documentId: q.documentId,
  }));

  const brief: FeatureBrief = {
    version: 1,
    recommendationId: rec.id,
    title: truncate(body.title.trim() || rec.title, 200),
    problemStatement: truncate(body.problemStatement.trim(), 4_000),
    userStories: body.userStories.slice(0, 6).map((s) => ({
      persona: truncate(s.persona.trim(), 120),
      action: truncate(s.action.trim(), 400),
      benefit: truncate(s.benefit.trim(), 400),
      acceptanceCriteria: cap(s.acceptanceCriteria, 6, 400),
    })),
    requirements: body.requirements.slice(0, 15).map((r, i) => ({
      id: /^P[01]-\d{1,3}$/.test(r.id.trim()) ? r.id.trim() : `${r.priority}-${i + 1}`,
      priority: r.priority,
      description: truncate(r.description.trim(), 600),
      acceptanceCriteria: cap(r.acceptanceCriteria, 6, 400),
    })),
    successMetrics: body.successMetrics.slice(0, 6).map((m) => ({
      metric: truncate(m.metric.trim(), 200),
      targetValue: truncate(m.targetValue.trim(), 200),
      measuringMethod: truncate(m.measuringMethod.trim(), 400),
    })),
    openQuestions: cap(body.openQuestions, 10, 400),
    risks: cap(body.risks, 10, 400),
    impactedSegments: cap(body.impactedSegments.length ? body.impactedSegments : rec.segments, 8, 80),
    expectedImpact: body.expectedImpact,
    confidenceLevel: rec.confidence,
    evidenceAppendix: appendixQuotes.length > 0 ? [{ category: "Customer evidence", quotes: appendixQuotes }] : [],
    generatedAt: new Date().toISOString(),
  };

  await prisma.recommendation.update({
    where: { id: rec.id },
    data: { brief: brief as unknown as Prisma.InputJsonValue, briefGeneratedAt: new Date(brief.generatedAt) },
  });
  return { brief, generated: true };
}
