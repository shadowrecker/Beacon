/**
 * Shared shapes for the data spine (documents → chunks → RAG / synthesis →
 * recommendations → briefs). Stored JSON columns are written in these shapes
 * and re-validated with the zod schemas next to their writers when read back.
 */

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

export interface ChunkMetadata {
  /** First and last page the chunk spans (PDFs). */
  pages?: [number, number];
  /** Speakers whose turns appear in the chunk (transcripts). */
  speakers?: string[];
  /** Start time of the first turn, in seconds (transcripts with timestamps). */
  startSec?: number;
  /** First and last data row (CSV, 1-based, excluding the header). */
  rows?: [number, number];
}

export interface ChunkData {
  content: string;
  /** 0-based ordinal within the document. */
  position: number;
  /** Character offsets into the document's processedText. */
  startOffset: number;
  endOffset: number;
  tokenCount: number;
  metadata: ChunkMetadata;
}

// ---------------------------------------------------------------------------
// RAG
// ---------------------------------------------------------------------------

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  position: number;
  /** Cosine similarity (vector arm), when retrieved by that arm. */
  similarity: number | null;
  /** ts_rank_cd score (keyword arm), when retrieved by that arm. */
  keywordRank: number | null;
  /** Reciprocal-rank-fusion score used for the final ordering. */
  score: number;
}

/** A citation whose chunk was retrieved for the question and whose quote is verbatim chunk text. */
export interface AnswerCitation {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  quote: string;
  /** Chunk ordinal within the document (for deep links). */
  position: number;
}

/** Shape stored in Query.citations. */
export interface StoredQueryCitations {
  items: AnswerCitation[];
  insufficientEvidence: boolean;
  /** Citations the model produced that failed verification and were dropped. */
  dropped: number;
  /** Number of chunks retrieved as context. */
  retrieved: number;
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export type Severity = "high" | "medium" | "low";

export interface SkippedDocument {
  documentId: string;
  title: string;
  reason: string;
}

export interface ThemeStats {
  themeId: string;
  /** Distinct documents that support the theme. */
  frequency: number;
  insightCount: number;
  severity: Severity;
  priorityScore: number;
  productAreas: string[];
  segments: string[];
}

/** Shape stored in Synthesis.output. */
export interface SynthesisOutput {
  version: 1;
  documentsConsidered: number;
  documentsAnalyzed: number;
  /** Documents that could not be analyzed (extraction failed or no text). */
  skippedDocuments: SkippedDocument[];
  /** Documents only partly analyzed because they exceed the per-document budget. */
  partialDocuments: Array<SkippedDocument & { analyzedChars: number; totalChars: number }>;
  /** READY documents beyond the per-run cap that were not included. */
  documentsNotIncluded: number;
  insightCount: number;
  themeCount: number;
  clusterBatches: number;
  themes: ThemeStats[];
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export interface EvidenceQuote {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  quote: string;
  /** Chunk ordinal within the document (for deep links), when known. */
  position?: number;
}

/** Shape stored in Recommendation.evidence. */
export interface RecommendationEvidence {
  themes: Array<{ id: string; name: string }>;
  quotes: EvidenceQuote[];
  rationale: string;
  /** Model-estimated confidence before blending with theme confidence. */
  modelConfidence: number;
}

// ---------------------------------------------------------------------------
// Feature briefs (stored in Recommendation.brief; reused by the handoff exporter)
// ---------------------------------------------------------------------------

export interface UserStory {
  persona: string;
  action: string;
  benefit: string;
  acceptanceCriteria: string[];
}

export interface Requirement {
  id: string;
  priority: "P0" | "P1";
  description: string;
  acceptanceCriteria: string[];
}

export interface SuccessMetric {
  metric: string;
  targetValue: string;
  measuringMethod: string;
}

export interface BriefQuote {
  text: string;
  /** Source document title. */
  context: string;
  chunkId: string;
  documentId: string;
}

export interface FeatureBrief {
  version: 1;
  recommendationId: string;
  title: string;
  problemStatement: string;
  userStories: UserStory[];
  requirements: Requirement[];
  successMetrics: SuccessMetric[];
  openQuestions: string[];
  risks: string[];
  impactedSegments: string[];
  expectedImpact: "high" | "medium" | "low";
  /** The recommendation's confidence (0-1) at generation time. */
  confidenceLevel: number;
  /** Server-assembled from verified recommendation evidence (never model-written). */
  evidenceAppendix: Array<{ category: string; quotes: BriefQuote[] }>;
  generatedAt: string;
}
