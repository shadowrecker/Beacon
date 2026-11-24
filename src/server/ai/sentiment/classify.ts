/**
 * Per-chunk sentiment classification on the bulk model, in bounded batches.
 *
 * Each chunk is labelled C1..Cn and wrapped as untrusted data; labels are
 * mapped back to chunk IDs here. A batch that fails at the model level is
 * recorded as failed (its chunks stay unclassified) and the rest continue;
 * budget and infrastructure errors abort the run so it can be retried.
 */
import { z } from "zod";
import type { Logger } from "@/lib/logger";
import { generateObject, LLMError } from "../client";
import { UNTRUSTED_DATA_POLICY, untrusted } from "../untrusted";

export const SENTIMENT_CLASSIFY_FEATURE = "sentiment.classify";
export const CLASSIFY_BATCH_CHUNKS = 20;
export const CLASSIFY_BATCH_CHARS = 24_000;
/** Text beyond this per chunk is not sent (chunks are normally far smaller). */
const MAX_CHARS_PER_CHUNK = 6_000;
const CONCURRENCY = 4;

export type SentimentLabel = "POSITIVE" | "NEUTRAL" | "NEGATIVE";

export interface ClassifyInput {
  id: string;
  content: string;
}

export interface ChunkSentiment {
  chunkId: string;
  label: SentimentLabel;
  /** -1 (very negative) to 1 (very positive). */
  score: number;
  themes: string[];
  /** Account/company the feedback is from, when the text names it. */
  customer: string | null;
  churnSignals: string[];
}

export interface ClassifyResult {
  results: ChunkSentiment[];
  failedChunks: number;
  failedBatches: number;
  truncatedChunks: number;
}

const schema = z.object({
  items: z.array(
    z.object({
      ref: z.string().describe("Chunk label, e.g. C3"),
      sentiment: z.enum(["POSITIVE", "NEUTRAL", "NEGATIVE"]),
      score: z.number().describe("-1 (very negative) to 1 (very positive)"),
      themes: z.array(z.string()).describe("Up to 3 short topic labels (2-4 words each)"),
      customer: z.string().nullable().describe("Name of the customer company or account the feedback comes from, only if the text states it; otherwise null"),
      churnSignals: z
        .array(z.string())
        .describe("Explicit churn-risk signals stated in the text (cancellation or downgrade intent, evaluating competitors, renewal at risk, unresolved escalation). Empty if none."),
    })
  ),
});

const SYSTEM = `You classify the sentiment of customer feedback excerpts for a product team.
For every labelled chunk return one item with: overall sentiment (POSITIVE, NEUTRAL or NEGATIVE), a score from -1 to 1, up to three short theme labels, the customer company or account the feedback comes from (only when stated in the text, otherwise null), and any explicit churn-risk signals.
Judge the customer's sentiment toward the product, not the tone of support agents. Return exactly one item per chunk label.

${UNTRUSTED_DATA_POLICY}`;

export function planClassifyBatches<T extends ClassifyInput>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const it of items) {
    const len = Math.min(it.content.length, MAX_CHARS_PER_CHUNK);
    if (cur.length > 0 && (cur.length >= CLASSIFY_BATCH_CHUNKS || chars + len > CLASSIFY_BATCH_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function clampScore(n: number, label: SentimentLabel): number {
  if (!Number.isFinite(n)) return label === "POSITIVE" ? 0.5 : label === "NEGATIVE" ? -0.5 : 0;
  return Math.max(-1, Math.min(1, n));
}

function cleanList(values: string[], max: number, maxLen: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = v.replace(/\s+/g, " ").trim().slice(0, maxLen);
    const k = s.toLowerCase();
    if (!s || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

async function classifyBatch(batch: ClassifyInput[], ctx: { orgId: string; projectId: string }): Promise<ChunkSentiment[]> {
  const prompt = `Classify these ${batch.length} feedback chunks.\n\n${batch
    .map((c, i) => untrusted(`C${i + 1}`, c.content.slice(0, MAX_CHARS_PER_CHUNK)))
    .join("\n\n")}`;
  const raw = await generateObject({
    feature: SENTIMENT_CLASSIFY_FEATURE,
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    system: SYSTEM,
    prompt,
    schema,
    tier: "bulk",
    maxTokens: 6_000,
  });
  const byLabel = new Map(batch.map((c, i) => [`c${i + 1}`, c.id]));
  const seen = new Set<string>();
  const out: ChunkSentiment[] = [];
  for (const item of raw.items) {
    const chunkId = byLabel.get(item.ref.trim().toLowerCase());
    if (!chunkId || seen.has(chunkId)) continue;
    seen.add(chunkId);
    const customer = item.customer?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
    out.push({
      chunkId,
      label: item.sentiment,
      score: clampScore(item.score, item.sentiment),
      themes: cleanList(item.themes, 3, 60),
      customer,
      churnSignals: cleanList(item.churnSignals, 5, 200),
    });
  }
  return out;
}

/** Classify chunks with bounded concurrency. Model-level batch failures are counted, not thrown. */
export async function classifyChunks(items: ClassifyInput[], ctx: { orgId: string; projectId: string }, log: Logger): Promise<ClassifyResult> {
  const batches = planClassifyBatches(items);
  const results: ChunkSentiment[] = [];
  let failedBatches = 0;
  let failedChunks = 0;
  const truncatedChunks = items.filter((i) => i.content.length > MAX_CHARS_PER_CHUNK).length;

  let next = 0;
  let fatal: unknown = null;
  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    while (fatal === null && next < batches.length) {
      const batch = batches[next++];
      try {
        const got = await classifyBatch(batch, ctx);
        results.push(...got);
        failedChunks += batch.length - got.length;
      } catch (err) {
        if (!(err instanceof LLMError)) {
          fatal = err;
          return;
        }
        failedBatches++;
        failedChunks += batch.length;
        log.warn("sentiment batch failed", { reason: err.reason, size: batch.length });
      }
    }
  });
  await Promise.all(workers);
  if (fatal !== null) throw fatal;
  return { results, failedChunks, failedBatches, truncatedChunks };
}
