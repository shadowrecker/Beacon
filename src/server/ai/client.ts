/**
 * Claude client: the only module that talks to the Anthropic API.
 *
 * - Current models (claude-opus-5-5 by default; claude-haiku-5-5 for bulk
 *   per-item work), overridable via MODEL_DEFAULT / MODEL_BULK.
 * - No sampling parameters (temperature/top_p are rejected by current models).
 * - Structured outputs via output_config.format + zod (betaZodOutputFormat), so the
 *   response is schema-validated instead of hand-parsed.
 * - Streaming with finalMessage() so large max_tokens never hits HTTP timeouts.
 * - stop_reason checks: refusal / max_tokens / context window are surfaced as
 *   typed, non-retryable errors.
 * - Server-side refusal fallbacks on the Opus/Sonnet path.
 * - Per-org monthly token budgets checked before, and usage recorded after,
 *   every call; org AI customization (custom AI config) applied centrally.
 * - Lazy construction: importing this module never throws, even without a key.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { assertTokenBudget, BudgetExceededError, recordTokenUsage } from "../usage/entitlements";
import { NonRetryableError } from "../jobs/worker";

export type ModelTier = "default" | "bulk";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LLMContext {
  /** Feature tag for usage attribution, e.g. "synthesis.extract". */
  feature: string;
  orgId: string;
  projectId?: string | null;
}

export interface GenerateObjectRequest<S extends z.ZodType> extends LLMContext {
  system: string;
  prompt: string;
  schema: S;
  tier?: ModelTier;
  effort?: Effort;
  maxTokens?: number;
}

export interface GenerateTextRequest extends LLMContext {
  system: string;
  prompt: string;
  tier?: ModelTier;
  effort?: Effort;
  maxTokens?: number;
}

export interface LLMUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Pluggable provider so tests run without network access. */
export interface LLMProvider {
  generateObject<S extends z.ZodType>(req: GenerateObjectRequest<S>): Promise<{ data: z.infer<S>; usage: LLMUsage }>;
  generateText(req: GenerateTextRequest): Promise<{ text: string; usage: LLMUsage }>;
}

export class LLMError extends NonRetryableError {
  constructor(
    message: string,
    public readonly reason: "refusal" | "truncated" | "invalid_output" | "context_exceeded" | "not_configured"
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export function modelFor(tier: ModelTier = "default"): string {
  return tier === "bulk"
    ? process.env.MODEL_BULK || "claude-haiku-5-5"
    : process.env.MODEL_DEFAULT || "claude-opus-5-5";
}

/** Haiku has no server-side refusal fallback; Opus/Sonnet do. */
function supportsServerFallback(model: string): boolean {
  return !model.includes("haiku");
}

// ---------------------------------------------------------------------------
// Org customization hook (custom AI config). Registered by
// src/server/ai/custom so this module has no dependency on the DB layer.
// ---------------------------------------------------------------------------

type CustomizationHook = (orgId: string, feature: string) => Promise<string | null>;
let customizationHook: CustomizationHook | null = null;
export function registerCustomizationHook(hook: CustomizationHook): void {
  customizationHook = hook;
}

async function systemWithCustomization(ctx: LLMContext, system: string): Promise<string> {
  if (!customizationHook) return system;
  try {
    const addendum = await customizationHook(ctx.orgId, ctx.feature);
    return addendum ? `${system}\n\n${addendum}` : system;
  } catch (err) {
    logger.warn("custom AI config unavailable; using defaults", { orgId: ctx.orgId, err });
    return system;
  }
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new LLMError("ANTHROPIC_API_KEY is not configured", "not_configured");
    anthropic = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
  }
  return anthropic;
}

function checkStop(stop: string | null | undefined, feature: string): void {
  if (stop === "refusal") throw new LLMError(`The model declined this request (${feature})`, "refusal");
  if (stop === "max_tokens") throw new LLMError(`The model's output was truncated (${feature})`, "truncated");
  if (stop === "model_context_window_exceeded") {
    throw new LLMError(`Input is too large for the model (${feature})`, "context_exceeded");
  }
}

function usageOf(model: string, u: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): LLMUsage {
  return {
    model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

const anthropicProvider: LLMProvider = {
  async generateObject(req) {
    const model = modelFor(req.tier);
    const stream = getAnthropic().beta.messages.stream({
      model,
      max_tokens: req.maxTokens ?? 16_000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.prompt }],
      output_config: {
        format: betaZodOutputFormat(req.schema),
        ...(req.effort ? { effort: req.effort } : {}),
      },
      ...(supportsServerFallback(model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });
    const msg = await stream.finalMessage();
    checkStop(msg.stop_reason, req.feature);
    if (msg.parsed_output === null || msg.parsed_output === undefined) {
      throw new LLMError(`The model returned output that did not match the schema (${req.feature})`, "invalid_output");
    }
    return { data: msg.parsed_output as z.infer<typeof req.schema>, usage: usageOf(msg.model ?? model, msg.usage) };
  },

  async generateText(req) {
    const model = modelFor(req.tier);
    const stream = getAnthropic().beta.messages.stream({
      model,
      max_tokens: req.maxTokens ?? 16_000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: req.prompt }],
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      ...(supportsServerFallback(model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    });
    const msg = await stream.finalMessage();
    checkStop(msg.stop_reason, req.feature);
    const text = msg.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return { text, usage: usageOf(msg.model ?? model, msg.usage) };
  },
};

let provider: LLMProvider = anthropicProvider;

export function setLLMProviderForTests(p: LLMProvider | null): void {
  provider = p ?? anthropicProvider;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function guard(ctx: LLMContext): Promise<void> {
  try {
    await assertTokenBudget(ctx.orgId);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw new NonRetryableError(err.message);
    throw err;
  }
}

async function record(ctx: LLMContext, usage: LLMUsage): Promise<void> {
  try {
    await recordTokenUsage({
      orgId: ctx.orgId,
      projectId: ctx.projectId ?? null,
      feature: ctx.feature,
      provider: "anthropic",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
  } catch (err) {
    logger.error("failed to record token usage", { feature: ctx.feature, err });
  }
}

/** Generate a schema-validated object. */
export async function generateObject<S extends z.ZodType>(req: GenerateObjectRequest<S>): Promise<z.infer<S>> {
  await guard(req);
  const system = await systemWithCustomization(req, req.system);
  const started = Date.now();
  const { data, usage } = await provider.generateObject({ ...req, system });
  await record(req, usage);
  logger.info("llm call", { feature: req.feature, model: usage.model, ms: Date.now() - started, in: usage.inputTokens, out: usage.outputTokens });
  return data;
}

/** Generate free text (answers, summaries). */
export async function generateText(req: GenerateTextRequest): Promise<string> {
  await guard(req);
  const system = await systemWithCustomization(req, req.system);
  const started = Date.now();
  const { text, usage } = await provider.generateText({ ...req, system });
  await record(req, usage);
  logger.info("llm call", { feature: req.feature, model: usage.model, ms: Date.now() - started, in: usage.inputTokens, out: usage.outputTokens });
  return text;
}
