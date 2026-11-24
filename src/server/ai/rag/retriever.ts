/**
 * Hybrid retrieval over a project's chunks.
 *
 * Two arms, both parameterized raw SQL against the mapped tables and both
 * filtered on the denormalized chunks."projectId" of the authorized project:
 *  - vector: cosine distance (`<=>`, HNSW index) against the question embedding,
 *    only over chunks embedded with the same model;
 *  - keyword: `to_tsvector('english', content) @@ websearch_to_tsquery(...)`
 *    (matches the GIN index expression exactly).
 * Results are merged with reciprocal rank fusion and deduplicated by chunk.
 */
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { embedText, toVectorLiteral } from "../embeddings";
import { FEATURES } from "../prompts";
import type { RetrievedChunk } from "../types";

export interface RetrieveInput {
  projectId: string;
  orgId: string;
  question: string;
  /** Final number of chunks to return. */
  limit?: number;
  /** Total characters of chunk content to return (prompt budget). */
  maxChars?: number;
}

interface Row {
  id: string;
  documentId: string;
  title: string;
  content: string;
  position: number;
  score: number;
}

const RRF_K = 60;

export async function retrieveChunks(input: RetrieveInput): Promise<RetrievedChunk[]> {
  const limit = input.limit ?? 12;
  const perArm = Math.max(limit * 2, 20);
  const maxChars = input.maxChars ?? 40_000;

  let vectorRows: Row[] = [];
  try {
    const { vector, model } = await embedText(input.question, {
      feature: FEATURES.queryEmbed,
      orgId: input.orgId,
      projectId: input.projectId,
    });
    const literal = toVectorLiteral(vector);
    vectorRows = await prisma.$queryRaw<Row[]>`
      SELECT c.id, c."documentId", d.title, c.content, c.position,
             (1 - (c.embedding <=> ${literal}::vector))::float8 AS score
      FROM chunks c
      JOIN documents d ON d.id = c."documentId"
      WHERE c."projectId" = ${input.projectId}
        AND c."embeddingModel" = ${model}
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${literal}::vector
      LIMIT ${perArm}`;
  } catch (err) {
    // Keyword retrieval still answers when embeddings are unavailable.
    logger.warn("vector retrieval unavailable; using keyword retrieval only", { projectId: input.projectId, err });
  }

  const keywordRows = await prisma.$queryRaw<Row[]>`
    SELECT c.id, c."documentId", d.title, c.content, c.position,
           ts_rank_cd(to_tsvector('english', c.content), q)::float8 AS score
    FROM chunks c
    JOIN documents d ON d.id = c."documentId",
         websearch_to_tsquery('english', ${input.question}) AS q
    WHERE c."projectId" = ${input.projectId}
      AND to_tsvector('english', c.content) @@ q
    ORDER BY score DESC
    LIMIT ${perArm}`;

  const merged = new Map<string, RetrievedChunk>();
  const add = (rows: Row[], arm: "vector" | "keyword") => {
    rows.forEach((r, rank) => {
      const existing = merged.get(r.id) ?? {
        chunkId: r.id,
        documentId: r.documentId,
        documentTitle: r.title,
        content: r.content,
        position: r.position,
        similarity: null,
        keywordRank: null,
        score: 0,
      };
      if (arm === "vector") existing.similarity = Number(r.score);
      else existing.keywordRank = Number(r.score);
      existing.score += 1 / (RRF_K + rank + 1);
      merged.set(r.id, existing);
    });
  };
  add(vectorRows, "vector");
  add(keywordRows, "keyword");

  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const out: RetrievedChunk[] = [];
  let chars = 0;
  for (const c of ranked) {
    if (out.length >= limit) break;
    if (out.length > 0 && chars + c.content.length > maxChars) continue;
    out.push(c);
    chars += c.content.length;
  }
  return out;
}
