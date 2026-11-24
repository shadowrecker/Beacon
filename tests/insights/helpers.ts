/**
 * Helpers for the insights tests (knowledge graph, sentiment, coach).
 *
 * The caller mounts only the insights routers (plus job) so these tests
 * do not depend on the state of unrelated routers.
 */
import type { DomainEvent } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createTestContext } from "@/server/context";
import { createCallerFactory, router } from "@/server/trpc";
import { knowledgeRouter } from "@/server/routers/knowledge";
import { sentimentRouter } from "@/server/routers/sentiment";
import { coachRouter } from "@/server/routers/coach";
import { jobRouter } from "@/server/routers/job";
import { toVectorLiteral } from "@/server/ai/embeddings";
import { fakeEmbedding } from "../helpers/doubles";
import type { TestUser } from "../helpers/factories";

const insightsRouter = router({ knowledge: knowledgeRouter, sentiment: sentimentRouter, coach: coachRouter, job: jobRouter });
const createCaller = createCallerFactory(insightsRouter);

export function insightsCaller(user: TestUser | null, orgId?: string) {
  return createCaller(
    createTestContext({
      user: user ? { id: user.id, clerkId: user.clerkId, email: user.email, name: user.name } : null,
      requestedOrgId: orgId ?? null,
    })
  );
}

export const testLog = logger.child({ test: "insights" });

/** Insert chunks for a document (with fake embeddings), in order. */
export async function addChunks(documentId: string, projectId: string, contents: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < contents.length; i++) {
    const c = await prisma.chunk.create({
      data: { documentId, projectId, content: contents[i], position: i, tokenCount: Math.ceil(contents[i].length / 4) },
      select: { id: true },
    });
    await prisma.$executeRaw`UPDATE chunks SET embedding = ${toVectorLiteral(fakeEmbedding(contents[i]))}::vector, "embeddingModel" = 'text-embedding-3-large' WHERE id = ${c.id}`;
    ids.push(c.id);
  }
  return ids;
}

/** A READY document created at `createdAt` with the given chunks and optional metadata. */
export async function documentWithChunks(
  projectId: string,
  opts: { title?: string; chunks: string[]; createdAt?: Date; metadata?: Record<string, unknown> }
): Promise<{ documentId: string; chunkIds: string[] }> {
  const text = opts.chunks.join("\n\n");
  const doc = await prisma.document.create({
    data: {
      projectId,
      title: opts.title ?? "Interview",
      type: "TRANSCRIPT",
      source: "UPLOAD",
      mimeType: "text/plain",
      processedText: text,
      status: "READY",
      ...(opts.metadata ? { metadata: opts.metadata as object } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
    select: { id: true },
  });
  const chunkIds = await addChunks(doc.id, projectId, opts.chunks);
  return { documentId: doc.id, chunkIds };
}

/** Persist a domain event row (as emitEvent would) for driving subscribers directly. */
export async function domainEvent(input: {
  orgId: string;
  projectId: string | null;
  type: string;
  payload: Record<string, unknown>;
  actorUserId?: string | null;
}): Promise<DomainEvent> {
  return prisma.domainEvent.create({
    data: {
      orgId: input.orgId,
      projectId: input.projectId,
      type: input.type,
      payload: input.payload as object,
      actorUserId: input.actorUserId ?? null,
    },
  });
}

/** Extract chunk labels (C1, C2, ...) and contents from a prompt built with untrusted(). */
export function chunksInPrompt(prompt: string): Array<{ label: string; text: string }> {
  const out: Array<{ label: string; text: string }> = [];
  const re = /<untrusted_data source="(C\d+)">\n([\s\S]*?)\n<\/untrusted_data>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push({ label: m[1], text: m[2] });
  return out;
}

export async function expectTRPCCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const actual = (err as { code?: string }).code;
    if (actual !== code) throw new Error(`Expected TRPC code ${code}, got ${actual}: ${(err as Error).message}`);
    return;
  }
  throw new Error(`Expected TRPC error ${code}, but the call succeeded`);
}
