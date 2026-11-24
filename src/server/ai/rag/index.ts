/**
 * Ask a question about one project's research: retrieve, answer, verify, store.
 * The caller has already authorized the project; every query here is scoped to
 * that project's id.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AnswerCitation, StoredQueryCitations } from "../types";
import { answerFromChunks } from "./answerer";
import { retrieveChunks } from "./retriever";

const NO_EVIDENCE_ANSWER =
  "I couldn't find anything in this project's documents that answers that. Try rephrasing the question, or add documents that cover the topic.";

export interface AskResult {
  id: string;
  question: string;
  answer: string;
  citations: AnswerCitation[];
  insufficientEvidence: boolean;
  createdAt: Date;
}

export async function askProject(input: { projectId: string; orgId: string; userId: string; question: string }): Promise<AskResult> {
  const question = input.question.trim();
  const chunks = await retrieveChunks({ projectId: input.projectId, orgId: input.orgId, question });

  let stored: StoredQueryCitations;
  let answer: string;
  if (chunks.length === 0) {
    answer = NO_EVIDENCE_ANSWER;
    stored = { items: [], insufficientEvidence: true, dropped: 0, retrieved: 0 };
  } else {
    const result = await answerFromChunks({ question, chunks, orgId: input.orgId, projectId: input.projectId });
    answer = result.answer;
    stored = {
      items: result.citations,
      insufficientEvidence: result.insufficientEvidence,
      dropped: result.dropped,
      retrieved: chunks.length,
    };
  }

  const row = await prisma.query.create({
    data: {
      projectId: input.projectId,
      userId: input.userId,
      question,
      answer,
      citations: stored as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, createdAt: true },
  });
  return { id: row.id, question, answer, citations: stored.items, insufficientEvidence: stored.insufficientEvidence, createdAt: row.createdAt };
}

const storedCitationSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  documentTitle: z.string(),
  quote: z.string(),
  position: z.number().int(),
});

const storedSchema = z.object({
  items: z.array(storedCitationSchema),
  insufficientEvidence: z.boolean(),
});

/** Read Query.citations back; rows from before this format yield no citations. */
export function parseStoredCitations(value: Prisma.JsonValue | null): { citations: AnswerCitation[]; insufficientEvidence: boolean } {
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) return { citations: [], insufficientEvidence: false };
  return { citations: parsed.data.items, insufficientEvidence: parsed.data.insufficientEvidence };
}
