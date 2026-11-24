/**
 * Grounded answering over retrieved chunks.
 *
 * The model receives each chunk as untrusted data labelled with its chunk id and
 * returns an answer plus citations ({chunkId, quote}). Citations are verified
 * server-side: the chunk must be one of the retrieved chunks and the quote must
 * occur in that chunk's content (whitespace/case/typographic-quote tolerant).
 * The stored quote is the verbatim chunk text; anything else is dropped.
 */
import { z } from "zod";
import { generateObject } from "../client";
import { untrusted } from "../untrusted";
import { FEATURES, QUERY_ANSWER_SYSTEM } from "../prompts";
import type { AnswerCitation, RetrievedChunk } from "../types";
import { locateQuote } from "../utils";

export const answerSchema = z.object({
  answer: z.string().describe("The answer in Markdown, without citation markers"),
  citations: z
    .array(
      z.object({
        chunkId: z.string().describe("Chunk id from the excerpt's source label"),
        quote: z.string().describe("Verbatim passage from that excerpt"),
      })
    )
    .describe("Supporting citations, most important first"),
  insufficientEvidence: z.boolean().describe("True when the excerpts do not answer the question"),
});

export interface GroundedAnswer {
  answer: string;
  citations: AnswerCitation[];
  insufficientEvidence: boolean;
  dropped: number;
}

const MAX_ANSWER_CHARS = 8_000;
const MAX_CITATIONS = 12;

export function verifyCitations(
  raw: Array<{ chunkId: string; quote: string }>,
  chunks: RetrievedChunk[]
): { citations: AnswerCitation[]; dropped: number } {
  const byId = new Map(chunks.map((c) => [c.chunkId, c]));
  const seen = new Set<string>();
  const citations: AnswerCitation[] = [];
  let dropped = 0;
  for (const c of raw) {
    const chunk = byId.get(c.chunkId.trim());
    const located = chunk ? locateQuote(chunk.content, c.quote) : null;
    if (!chunk || !located) {
      dropped++;
      continue;
    }
    const key = `${chunk.chunkId}:${located.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (citations.length >= MAX_CITATIONS) continue;
    citations.push({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      quote: located.text,
      position: chunk.position,
    });
  }
  return { citations, dropped };
}

export async function answerFromChunks(input: {
  question: string;
  chunks: RetrievedChunk[];
  orgId: string;
  projectId: string;
}): Promise<GroundedAnswer> {
  const excerpts = input.chunks
    .map((c) => untrusted(`chunk:${c.chunkId}`, `Document: ${c.documentTitle}\n\n${c.content}`))
    .join("\n\n");
  const prompt = `Excerpts from the project's customer research:\n\n${excerpts}\n\nQuestion from the product manager (answer it using only the excerpts above):\n${input.question}`;

  const out = await generateObject({
    feature: FEATURES.queryAnswer,
    orgId: input.orgId,
    projectId: input.projectId,
    system: QUERY_ANSWER_SYSTEM,
    prompt,
    schema: answerSchema,
    effort: "medium",
    maxTokens: 8_000,
  });

  const { citations, dropped } = verifyCitations(out.citations, input.chunks);
  const answer = out.answer.trim().slice(0, MAX_ANSWER_CHARS);
  return {
    answer: answer || "I couldn't produce an answer from this project's documents.",
    citations,
    // An answer with no verifiable support is treated as insufficient evidence.
    insufficientEvidence: out.insufficientEvidence || citations.length === 0,
    dropped,
  };
}
