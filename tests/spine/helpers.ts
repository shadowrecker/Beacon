/**
 * Shared helpers for the data-spine tests.
 */
import { expect } from "vitest";
import { prisma } from "@/lib/db";
import { runJob, type WorkerDefinition } from "@/server/jobs/worker";
import type { QueueName } from "@/server/jobs/queues";
import { createTestContext } from "@/server/context";
import { createCallerFactory, router } from "@/server/trpc";
import { projectRouter } from "@/server/routers/project";
import { documentRouter } from "@/server/routers/document";
import { queryRouter } from "@/server/routers/query";
import { synthesisRouter } from "@/server/routers/synthesis";
import { recommendationRouter } from "@/server/routers/recommendation";
import { jobRouter } from "@/server/routers/job";
import { jobsFor, storage } from "../helpers/doubles";
import type { TestUser } from "../helpers/factories";

/**
 * The data-spine routers mounted under the same names as in appRouter. Tests
 * use this instead of the full app router so they exercise exactly these
 * procedures without depending on unrelated feature routers.
 */
const spineRouter = router({
  project: projectRouter,
  document: documentRouter,
  query: queryRouter,
  synthesis: synthesisRouter,
  recommendation: recommendationRouter,
  job: jobRouter,
});
const createCaller = createCallerFactory(spineRouter);

/** A caller authenticated as `user`, optionally acting in `orgId` (x-org-id). */
export function callerFor(user: TestUser | null, orgId?: string) {
  return createCaller(
    createTestContext({
      user: user ? { id: user.id, clerkId: user.clerkId, email: user.email, name: user.name } : null,
      requestedOrgId: orgId ?? null,
    })
  );
}

/** Run a worker definition's handler through the real job wrapper. */
export async function runWorker<Q extends QueueName>(def: WorkerDefinition<Q>, payload: unknown, attempt = 1, maxAttempts = 3) {
  return runJob(def, payload, { jobId: `test_${Date.now()}`, attempt, maxAttempts });
}

/** Upload `body` through the real presign → store → confirm flow; returns the document id. */
export async function uploadFile(user: TestUser, projectId: string, filename: string, body: Buffer | string, type: "TRANSCRIPT" | "SUPPORT_TICKET" | "NOTE" | "CALL_RECORDING" | "OTHER" = "TRANSCRIPT") {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const caller = callerFor(user);
  const presign = await caller.document.getUploadUrl({ projectId, filename, size: bytes.length });
  // The memory driver stands in for S3: the client would POST these fields + file.
  await storage.put(presign.fields.key, bytes, presign.contentType);
  await caller.document.confirmUpload({ projectId, documentId: presign.documentId, type });
  return presign.documentId;
}

export async function eventsOfType(type: string) {
  return prisma.domainEvent.findMany({ where: { type }, orderBy: { createdAt: "asc" } });
}

export async function embeddedChunkCount(documentId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM chunks WHERE "documentId" = ${documentId} AND embedding IS NOT NULL AND "embeddingModel" IS NOT NULL`;
  return Number(rows[0].n);
}

export function lastJobPayload<T>(queue: string): T {
  const list = jobsFor(queue);
  expect(list.length).toBeGreaterThan(0);
  return list[list.length - 1].payload as T;
}

/** Extract chunk ids and their text from an LLM prompt built with untrusted("chunk:<id>", ...). */
export function chunksInPrompt(prompt: string): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const re = /<untrusted_data source="chunk:([^"]+)">\n([\s\S]*?)\n<\/untrusted_data>/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) out.push({ id: m[1], text: m[2] });
  return out;
}
