/**
 * Map step: per-document insight extraction.
 *
 * A document's chunks are sent in windows bounded by WINDOW_CHARS (at most
 * MAX_WINDOWS per document; anything beyond is reported as partial, never
 * silently dropped). Each chunk is labelled with its id so evidence quotes can
 * be verified against the chunk text; unverifiable evidence is discarded.
 */
import { z } from "zod";
import { generateObject } from "../client";
import { untrusted } from "../untrusted";
import { FEATURES, SYNTHESIS_EXTRACT_SYSTEM } from "../prompts";
import type { EvidenceQuote, Severity } from "../types";
import { batchBySize, locateQuote, truncate } from "../utils";

export const WINDOW_CHARS = 60_000;
export const MAX_WINDOWS = 4;
const MAX_INSIGHTS_PER_WINDOW = 25;
const MAX_EVIDENCE_PER_INSIGHT = 3;

export const INSIGHT_KINDS = ["pain_point", "feature_request", "positive", "observation"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
export type ThemeSentiment = "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";

export const extractionSchema = z.object({
  insights: z.array(
    z.object({
      kind: z.enum(INSIGHT_KINDS),
      summary: z.string(),
      severity: z.enum(["high", "medium", "low"]),
      sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"]),
      productArea: z.string().nullable(),
      evidence: z.array(z.object({ chunkId: z.string(), quote: z.string() })),
    })
  ),
  segment: z.string().nullable(),
});

export interface Insight {
  documentId: string;
  documentTitle: string;
  kind: InsightKind;
  summary: string;
  severity: Severity;
  sentiment: ThemeSentiment;
  productArea: string | null;
  segment: string | null;
  evidence: EvidenceQuote[];
}

export interface ExtractionChunk {
  id: string;
  content: string;
}

export interface DocumentExtraction {
  insights: Insight[];
  analyzedChars: number;
  totalChars: number;
}

export async function extractDocumentInsights(input: {
  document: { id: string; title: string };
  chunks: ExtractionChunk[];
  orgId: string;
  projectId: string;
}): Promise<DocumentExtraction> {
  const totalChars = input.chunks.reduce((n, c) => n + c.content.length, 0);
  const windows = batchBySize(input.chunks, 500, WINDOW_CHARS, (c) => c.content.length + 80).slice(0, MAX_WINDOWS);
  const insights: Insight[] = [];
  let analyzedChars = 0;

  for (const [w, windowChunks] of windows.entries()) {
    analyzedChars += windowChunks.reduce((n, c) => n + c.content.length, 0);
    const byId = new Map(windowChunks.map((c) => [c.id, c]));
    const part = windows.length > 1 ? ` (part ${w + 1} of ${windows.length})` : "";
    const prompt = `Document title: ${untrusted("document-title", input.document.title)}\n\nDocument excerpts${part}, in order:\n\n${windowChunks
      .map((c) => untrusted(`chunk:${c.id}`, c.content))
      .join("\n\n")}`;

    const out = await generateObject({
      feature: FEATURES.synthesisExtract,
      orgId: input.orgId,
      projectId: input.projectId,
      system: SYNTHESIS_EXTRACT_SYSTEM,
      prompt,
      schema: extractionSchema,
      tier: "bulk",
      maxTokens: 8_000,
    });

    const segment = out.segment?.trim() ? truncate(out.segment.trim(), 60) : null;
    for (const raw of out.insights.slice(0, MAX_INSIGHTS_PER_WINDOW)) {
      const summary = truncate(raw.summary.trim(), 300);
      if (!summary) continue;
      const evidence: EvidenceQuote[] = [];
      for (const e of raw.evidence) {
        const chunk = byId.get(e.chunkId.trim());
        const located = chunk ? locateQuote(chunk.content, e.quote) : null;
        if (!chunk || !located) continue;
        if (evidence.some((x) => x.chunkId === chunk.id && x.quote === located.text)) continue;
        evidence.push({ chunkId: chunk.id, documentId: input.document.id, documentTitle: input.document.title, quote: located.text });
        if (evidence.length >= MAX_EVIDENCE_PER_INSIGHT) break;
      }
      insights.push({
        documentId: input.document.id,
        documentTitle: input.document.title,
        kind: raw.kind,
        summary,
        severity: raw.severity,
        sentiment: raw.sentiment,
        productArea: raw.productArea?.trim() ? truncate(raw.productArea.trim(), 60) : null,
        segment,
        evidence,
      });
    }
  }
  return { insights, analyzedChars, totalChars };
}
