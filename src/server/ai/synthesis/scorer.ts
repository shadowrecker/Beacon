/**
 * Deterministic theme scoring from the evidence behind each theme (no model
 * call, so scores are reproducible and explainable):
 *
 *   support    = min(1, distinct supporting documents / 3)
 *   evidence   = min(1, verified quotes / 4)
 *   coverage   = distinct supporting documents / documents analyzed
 *   confidence = 0.45·support + 0.30·evidence + 0.25·coverage
 *   priority   = confidence · (0.5 + 0.5·severityWeight)
 *
 * Sentiment is the majority of the insights' sentiments (MIXED when positive and
 * negative are both substantial); severity is the weighted mean of insight
 * severities.
 */
import type { EvidenceQuote, Severity } from "../types";
import { clamp, round } from "../utils";
import type { ThemeCandidate, IndexedInsight } from "./clusterer";
import type { ThemeSentiment } from "./extractor";

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 1, medium: 0.6, low: 0.3 };
const MAX_CITATIONS_PER_THEME = 20;

export interface ScoredCitation extends EvidenceQuote {
  relevanceScore: number;
}

export interface ScoredTheme {
  name: string;
  description: string;
  sentiment: ThemeSentiment;
  severity: Severity;
  confidenceScore: number;
  priorityScore: number;
  frequency: number;
  insightCount: number;
  productAreas: string[];
  segments: string[];
  citations: ScoredCitation[];
}

function majoritySentiment(insights: IndexedInsight[]): ThemeSentiment {
  const counts: Record<ThemeSentiment, number> = { POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0, MIXED: 0 };
  for (const i of insights) counts[i.sentiment]++;
  const polar = counts.POSITIVE + counts.NEGATIVE;
  if (polar > 0 && Math.min(counts.POSITIVE, counts.NEGATIVE) / polar >= 0.3) return "MIXED";
  return (Object.entries(counts) as Array<[ThemeSentiment, number]>).sort((a, b) => b[1] - a[1])[0][0];
}

function topValues(values: Array<string | null>, max: number): string[] {
  const counts = new Map<string, { label: string; n: number }>();
  for (const v of values) {
    if (!v) continue;
    const key = v.toLowerCase();
    const entry = counts.get(key) ?? { label: v, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((e) => e.label);
}

export function scoreThemes(candidates: ThemeCandidate[], insightsByRef: Map<string, IndexedInsight>, documentsAnalyzed: number): ScoredTheme[] {
  const scored: ScoredTheme[] = [];
  for (const c of candidates) {
    const insights = c.insightRefs.map((r) => insightsByRef.get(r)).filter((i): i is IndexedInsight => Boolean(i));
    if (insights.length === 0) continue;

    const docs = new Set(insights.map((i) => i.documentId));
    const citations: ScoredCitation[] = [];
    const seen = new Set<string>();
    for (const i of insights) {
      for (const e of i.evidence) {
        const key = `${e.chunkId}\u0000${e.quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({ ...e, relevanceScore: SEVERITY_WEIGHT[i.severity] });
      }
    }
    citations.sort((a, b) => b.relevanceScore - a.relevanceScore);

    const severityWeight = insights.reduce((s, i) => s + SEVERITY_WEIGHT[i.severity], 0) / insights.length;
    const severity: Severity = severityWeight >= 0.75 ? "high" : severityWeight >= 0.45 ? "medium" : "low";
    const support = Math.min(1, docs.size / 3);
    const evidence = Math.min(1, citations.length / 4);
    const coverage = documentsAnalyzed > 0 ? docs.size / documentsAnalyzed : 0;
    const confidenceScore = round(clamp(0.45 * support + 0.3 * evidence + 0.25 * coverage, 0, 1));
    const priorityScore = round(confidenceScore * (0.5 + 0.5 * severityWeight));

    scored.push({
      name: c.name,
      description: c.description,
      sentiment: majoritySentiment(insights),
      severity,
      confidenceScore,
      priorityScore,
      frequency: docs.size,
      insightCount: insights.length,
      productAreas: topValues(insights.map((i) => i.productArea), 5),
      segments: topValues(insights.map((i) => i.segment), 5),
      citations: citations.slice(0, MAX_CITATIONS_PER_THEME),
    });
  }
  return scored.sort((a, b) => b.priorityScore - a.priorityScore || b.frequency - a.frequency);
}
