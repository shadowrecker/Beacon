/**
 * Test doubles for external services, installed for every test.
 *
 * - LLM: scripted per feature tag via `scriptLLM(feature, fn)`. Unscripted calls
 *   throw, so a test never silently passes on a default answer.
 * - Embeddings: deterministic feature-hashing vectors (bag of words into 1536
 *   buckets, L2-normalized), so cosine similarity tracks word overlap.
 * - Storage: in-memory driver.
 * - Jobs: enqueue() captures jobs instead of writing to Redis.
 */
import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  setLLMProviderForTests,
  type GenerateObjectRequest,
  type GenerateTextRequest,
  type LLMProvider,
} from "@/server/ai/client";
import { EMBEDDING_DIMENSION, setEmbeddingProviderForTests } from "@/server/ai/embeddings";
import { MemoryStorageDriver, setStorageDriverForTests } from "@/lib/storage";
import { captureJobsForTests, type CapturedJob } from "@/server/jobs/queues";

type ObjectHandler = (req: GenerateObjectRequest<z.ZodType>) => unknown;
type TextHandler = (req: GenerateTextRequest) => string;

const objectScripts = new Map<string, ObjectHandler>();
const textScripts = new Map<string, TextHandler>();
export const llmCalls: Array<{ feature: string; system: string; prompt: string }> = [];

export function scriptLLM(feature: string, handler: ObjectHandler): void {
  objectScripts.set(feature, handler);
}
export function scriptLLMText(feature: string, handler: TextHandler): void {
  textScripts.set(feature, handler);
}

const usage = { model: "fake-model", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

const fakeLLM: LLMProvider = {
  async generateObject(req) {
    llmCalls.push({ feature: req.feature, system: req.system, prompt: req.prompt });
    const handler = objectScripts.get(req.feature);
    if (!handler) throw new Error(`No fake LLM script for feature "${req.feature}"`);
    // Validate like the real structured-output path would.
    const data = req.schema.parse(handler(req as GenerateObjectRequest<z.ZodType>));
    return { data, usage };
  },
  async generateText(req) {
    llmCalls.push({ feature: req.feature, system: req.system, prompt: req.prompt });
    const handler = textScripts.get(req.feature);
    if (!handler) throw new Error(`No fake LLM text script for feature "${req.feature}"`);
    return { text: handler(req), usage };
  },
};

export function fakeEmbedding(text: string): number[] {
  const v = new Array(EMBEDDING_DIMENSION).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  for (const w of words) {
    const h = createHash("md5").update(w).digest();
    v[h.readUInt32BE(0) % EMBEDDING_DIMENSION] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  if (words.length === 0) v[0] = 1;
  return v.map((x) => x / norm);
}

export let storage: MemoryStorageDriver = new MemoryStorageDriver();
export let jobs: CapturedJob[] = [];

export function installTestDoubles(): void {
  setLLMProviderForTests(fakeLLM);
  setEmbeddingProviderForTests({
    async embed(texts) {
      return { vectors: texts.map(fakeEmbedding), tokens: texts.length * 10 };
    },
  });
}

export function resetTestDoubles(): void {
  objectScripts.clear();
  textScripts.clear();
  llmCalls.length = 0;
  storage = new MemoryStorageDriver();
  setStorageDriverForTests(storage);
  jobs = captureJobsForTests();
}

/** Jobs captured for one queue. */
export function jobsFor(queue: string): CapturedJob[] {
  return jobs.filter((j) => j.queue === queue);
}
