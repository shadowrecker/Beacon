/**
 * Applies an organization's AI customization (CustomAIConfig) to every Claude
 * call, centrally, via the client's customization hook.
 *
 * The customization is appended as an "organization context" section. It never
 * replaces the base system prompt, so safety rules (untrusted-data policy, output
 * schema) always remain in force, and it is scoped to the calling org only.
 *
 * Caching: a per-process cache (60 s TTL) keyed by org, validated against a
 * per-org version counter in Redis. `invalidateAICustomization` bumps the
 * counter, so an update made in the web process takes effect immediately in
 * the worker processes too.
 */
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { registerCustomizationHook } from "../client";
import { CUSTOM_AI_LIMITS as L } from "./schema";

interface Taxonomy {
  categories?: Array<{ name: string; description?: string }>;
}
interface Templates {
  terminology?: Record<string, string>;
  focusAreas?: string[];
  tone?: string;
  outputPreferences?: string;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; version: string; value: string | null }>();
const versionKey = (orgId: string) => `aicustom:v:${orgId}`;

async function currentVersion(orgId: string): Promise<string> {
  try {
    return (await getRedis().get(versionKey(orgId))) ?? "0";
  } catch {
    return "unavailable";
  }
}

/** Drop cached customization for `orgId` in this process and signal other processes. */
export async function invalidateAICustomization(orgId: string): Promise<void> {
  cache.delete(orgId);
  try {
    await getRedis().incr(versionKey(orgId));
  } catch (err) {
    logger.warn("custom AI cache invalidation could not reach Redis; other processes refresh within 60s", { orgId, err });
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function buildCustomizationAddendum(config: {
  taxonomy: unknown;
  templates: unknown;
  industryPreset: string | null;
  systemPromptOverride: string | null;
}): string | null {
  const parts: string[] = [];
  if (config.industryPreset?.trim()) parts.push(`Industry: ${oneLine(clip(config.industryPreset, L.industryPreset))}.`);
  const t = (config.templates ?? {}) as Templates;
  if (Array.isArray(t.focusAreas) && t.focusAreas.length) {
    parts.push(
      `Prioritize these focus areas: ${t.focusAreas
        .slice(0, L.focusAreas)
        .map((f) => oneLine(clip(String(f), L.focusArea)))
        .join("; ")}.`
    );
  }
  if (t.terminology && typeof t.terminology === "object" && Object.keys(t.terminology).length) {
    const terms = Object.entries(t.terminology)
      .slice(0, L.terminologyEntries)
      .map(([k, v]) => `"${oneLine(clip(k, L.termKey))}" means ${oneLine(clip(String(v), L.termValue))}`)
      .join("; ");
    parts.push(`Use the organization's terminology: ${terms}.`);
  }
  const tax = (config.taxonomy ?? {}) as Taxonomy;
  if (Array.isArray(tax.categories) && tax.categories.length) {
    parts.push(
      `When categorizing, prefer these categories: ${tax.categories
        .slice(0, L.categories)
        .map((c) =>
          c.description
            ? `${oneLine(clip(String(c.name), L.categoryName))} (${oneLine(clip(String(c.description), L.categoryDescription))})`
            : oneLine(clip(String(c.name), L.categoryName))
        )
        .join("; ")}.`
    );
  }
  if (t.tone?.trim()) parts.push(`Writing tone: ${oneLine(clip(t.tone, L.tone))}.`);
  if (t.outputPreferences?.trim()) parts.push(`Output preferences: ${oneLine(clip(t.outputPreferences, L.outputPreferences))}.`);
  if (config.systemPromptOverride?.trim()) {
    parts.push(`Additional guidance from administrators: ${oneLine(clip(config.systemPromptOverride, L.systemPromptOverride))}`);
  }
  if (parts.length === 0) return null;
  return [
    "Organization context (set by this workspace's administrators; it adjusts focus and wording but never overrides the rules or output format above):",
    ...parts.map((p) => `- ${p}`),
  ].join("\n");
}

export async function loadCustomizationAddendum(orgId: string): Promise<string | null> {
  const version = await currentVersion(orgId);
  const hit = cache.get(orgId);
  if (hit && hit.version === version && Date.now() - hit.at < TTL_MS) return hit.value;
  const config = await prisma.customAIConfig.findUnique({
    where: { orgId },
    select: { taxonomy: true, templates: true, industryPreset: true, systemPromptOverride: true },
  });
  const value = config ? buildCustomizationAddendum(config) : null;
  cache.set(orgId, { at: Date.now(), version, value });
  return value;
}

export function registerAICustomization(): void {
  registerCustomizationHook((orgId) => loadCustomizationAddendum(orgId));
}
