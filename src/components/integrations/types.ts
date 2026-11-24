import type { RouterOutputs } from "@/lib/trpc";

export type ProviderInfo = RouterOutputs["integration"]["providers"][number];
export type FieldSpec = ProviderInfo["credentialFields"][number];
export type IntegrationRow = RouterOutputs["integration"]["list"][number];
export type SyncRow = RouterOutputs["integration"]["syncHistory"]["items"][number];

export const CATEGORY_ORDER: ProviderInfo["category"][] = ["Support", "Sales", "Calls", "Communication", "Product", "Docs", "Analytics"];

/** Settings whose values are numbers on the server (selects carry strings). */
export const NUMERIC_CONFIG_KEYS = new Set(["syncIntervalMinutes", "backfillDays"]);
