/**
 * Text embeddings (OpenAI) and pgvector helpers.
 *
 * - Lazy client; reads OPENAI_API_KEY and EMBEDDING_MODEL (default
 *   text-embedding-3-large reduced to 1536 dimensions to match vector(1536)).
 * - Batches by item count and approximate token budget; preserves input order;
 *   empty inputs map to null instead of failing the whole batch.
 * - The model name is returned so it is stored per chunk; vectors from different
 *   models are never compared (see retriever).
 * - Usage is recorded against the org for budgets.
 */
import OpenAI from "openai";
import { logger } from "@/lib/logger";
import { recordTokenUsage } from "../usage/entitlements";
import { LLMError, type LLMContext } from "./client";

export const EMBEDDING_DIMENSION = 1536;
const MAX_BATCH_ITEMS = 128;
/** Rough per-request token budget (the API limit is ~300k tokens per request). */
const MAX_BATCH_TOKENS = 200_000;
/** text-embedding-3 accepts up to 8191 tokens per input; keep a margin. */
const MAX_INPUT_CHARS = 24_000;

export function embeddingModel(): string {
  return process.env.EMBEDDING_MODEL || "text-embedding-3-large";
}

export interface EmbeddingProvider {
  embed(texts: string[], model: string): Promise<{ vectors: number[][]; tokens: number }>;
}

let openai: OpenAI | null = null;
const openaiProvider: EmbeddingProvider = {
  async embed(texts, model) {
    if (!openai) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new LLMError("OPENAI_API_KEY is not configured", "not_configured");
      openai = new OpenAI({ apiKey, maxRetries: 3, timeout: 120_000 });
    }
    const res = await openai.embeddings.create({ model, input: texts, dimensions: EMBEDDING_DIMENSION });
    const vectors = res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { vectors, tokens: res.usage?.total_tokens ?? 0 };
  },
};

let provider: EmbeddingProvider = openaiProvider;
export function setEmbeddingProviderForTests(p: EmbeddingProvider | null): void {
  provider = p ?? openaiProvider;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Embed many texts. Returns vectors in input order; entries for empty texts are
 * null. Throws on provider errors (callers decide whether to retry).
 */
export async function embedTexts(
  texts: string[],
  ctx: LLMContext
): Promise<{ vectors: Array<number[] | null>; model: string }> {
  const model = embeddingModel();
  const out: Array<number[] | null> = new Array(texts.length).fill(null);
  const items = texts
    .map((t, i) => ({ i, text: (t ?? "").trim().slice(0, MAX_INPUT_CHARS) }))
    .filter((x) => x.text.length > 0);

  let batch: typeof items = [];
  let batchTokens = 0;
  let totalTokens = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const { vectors, tokens } = await provider.embed(
      batch.map((b) => b.text),
      model
    );
    if (vectors.length !== batch.length) throw new Error("Embedding count mismatch");
    vectors.forEach((v, k) => {
      if (v.length !== EMBEDDING_DIMENSION) throw new Error(`Unexpected embedding dimension ${v.length}`);
      out[batch[k].i] = v;
    });
    totalTokens += tokens;
    batch = [];
    batchTokens = 0;
  };

  for (const item of items) {
    const t = approxTokens(item.text);
    if (batch.length >= MAX_BATCH_ITEMS || batchTokens + t > MAX_BATCH_TOKENS) await flush();
    batch.push(item);
    batchTokens += t;
  }
  await flush();

  if (totalTokens > 0) {
    await recordTokenUsage({
      orgId: ctx.orgId,
      projectId: ctx.projectId ?? null,
      feature: ctx.feature,
      provider: "openai",
      model,
      inputTokens: totalTokens,
      outputTokens: 0,
    }).catch((err) => logger.error("failed to record embedding usage", { err }));
  }
  return { vectors: out, model };
}

export async function embedText(text: string, ctx: LLMContext): Promise<{ vector: number[]; model: string }> {
  const { vectors, model } = await embedTexts([text], ctx);
  if (!vectors[0]) throw new Error("Cannot embed empty text");
  return { vector: vectors[0], model };
}

/** Serialize a vector for a `::vector` cast in raw SQL (always a bound parameter). */
export function toVectorLiteral(v: number[]): string {
  if (v.length !== EMBEDDING_DIMENSION || v.some((x) => !Number.isFinite(x))) {
    throw new Error("Invalid embedding vector");
  }
  return `[${v.join(",")}]`;
}
