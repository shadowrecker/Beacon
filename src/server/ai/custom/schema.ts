/**
 * Custom AI configuration schema. Isomorphic (zod only) so the settings
 * UI validates with exactly the limits the server enforces.
 *
 * Everything here is org-operator context. It is appended to system prompts as
 * an "organization context" section by hook.ts and never replaces a base
 * prompt, so it cannot switch off the untrusted-data policy, output schemas or
 * tenancy rules. `systemPromptOverride` is kept as the column name for
 * compatibility; it is additional guidance, not an override.
 */
import { z } from "zod";

export const CUSTOM_AI_LIMITS = {
  industryPreset: 100,
  terminologyEntries: 50,
  termKey: 60,
  termValue: 200,
  focusAreas: 20,
  focusArea: 80,
  tone: 200,
  outputPreferences: 500,
  categories: 40,
  categoryName: 60,
  categoryDescription: 120,
  systemPromptOverride: 2000,
} as const;

const L = CUSTOM_AI_LIMITS;

export const INDUSTRY_PRESETS = ["B2B SaaS", "Fintech", "Healthcare", "E-commerce", "Enterprise software", "Consumer apps", "Developer tools", "Marketplaces"] as const;

const text = (max: number, label: string) => z.string().trim().max(max, `${label} must be at most ${max} characters`);

export const customAIConfigSchema = z
  .object({
    industryPreset: text(L.industryPreset, "Industry").nullable().default(null),
    templates: z
      .object({
        terminology: z
          .record(
            text(L.termKey, "Term").min(1, "Term is required"),
            text(L.termValue, "Definition").min(1, "Definition is required")
          )
          .refine((r) => Object.keys(r).length <= L.terminologyEntries, `At most ${L.terminologyEntries} terms`)
          .default({}),
        focusAreas: z
          .array(text(L.focusArea, "Focus area").min(1, "Focus areas cannot be empty"))
          .max(L.focusAreas, `At most ${L.focusAreas} focus areas`)
          .default([]),
        tone: text(L.tone, "Tone").default(""),
        outputPreferences: text(L.outputPreferences, "Output preferences").default(""),
      })
      .strict()
      .default({ terminology: {}, focusAreas: [], tone: "", outputPreferences: "" }),
    taxonomy: z
      .object({
        categories: z
          .array(
            z
              .object({
                name: text(L.categoryName, "Category name").min(1, "Category name is required"),
                description: text(L.categoryDescription, "Category description").optional(),
              })
              .strict()
          )
          .max(L.categories, `At most ${L.categories} categories`)
          .default([]),
      })
      .strict()
      .default({ categories: [] }),
    systemPromptOverride: text(L.systemPromptOverride, "Additional instructions").nullable().default(null),
  })
  .strict();

export type CustomAIConfigInput = z.input<typeof customAIConfigSchema>;
export type CustomAIConfigValue = z.infer<typeof customAIConfigSchema>;

export const EMPTY_CUSTOM_AI_CONFIG: CustomAIConfigValue = {
  industryPreset: null,
  templates: { terminology: {}, focusAreas: [], tone: "", outputPreferences: "" },
  taxonomy: { categories: [] },
  systemPromptOverride: null,
};

/** Coerce a stored row (JSON columns, possibly legacy-shaped) into a valid value. */
export function normalizeStoredConfig(row: {
  industryPreset: string | null;
  templates: unknown;
  taxonomy: unknown;
  systemPromptOverride: string | null;
} | null): CustomAIConfigValue {
  if (!row) return EMPTY_CUSTOM_AI_CONFIG;
  const t = (row.templates ?? {}) as Record<string, unknown>;
  const tax = (row.taxonomy ?? {}) as Record<string, unknown>;
  const candidate = {
    industryPreset: row.industryPreset ? row.industryPreset.slice(0, L.industryPreset) : null,
    templates: {
      terminology:
        t.terminology && typeof t.terminology === "object" && !Array.isArray(t.terminology)
          ? Object.fromEntries(
              Object.entries(t.terminology as Record<string, unknown>)
                .filter(([k, v]) => k.trim() && typeof v === "string" && v.trim())
                .slice(0, L.terminologyEntries)
                .map(([k, v]) => [k.trim().slice(0, L.termKey), (v as string).trim().slice(0, L.termValue)])
            )
          : {},
      focusAreas: Array.isArray(t.focusAreas)
        ? t.focusAreas.filter((f): f is string => typeof f === "string" && !!f.trim()).slice(0, L.focusAreas).map((f) => f.trim().slice(0, L.focusArea))
        : [],
      tone: typeof t.tone === "string" ? t.tone.slice(0, L.tone) : "",
      outputPreferences: typeof t.outputPreferences === "string" ? t.outputPreferences.slice(0, L.outputPreferences) : "",
    },
    taxonomy: {
      categories: Array.isArray(tax.categories)
        ? tax.categories
            .filter((c): c is { name: string; description?: unknown } => !!c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string")
            .filter((c) => c.name.trim())
            .slice(0, L.categories)
            .map((c) => ({
              name: c.name.trim().slice(0, L.categoryName),
              ...(typeof c.description === "string" && c.description.trim() ? { description: c.description.trim().slice(0, L.categoryDescription) } : {}),
            }))
        : [],
    },
    systemPromptOverride: row.systemPromptOverride ? row.systemPromptOverride.slice(0, L.systemPromptOverride) : null,
  };
  const parsed = customAIConfigSchema.safeParse(candidate);
  return parsed.success ? parsed.data : EMPTY_CUSTOM_AI_CONFIG;
}
