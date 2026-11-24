/**
 * Reduce step: cluster insights into themes in bounded batches, then merge the
 * per-batch themes hierarchically until one consolidated list remains.
 *
 * The model only ever refers to server-assigned short ids ("i12", "t3"); unknown
 * ids are ignored and each insight is assigned to at most one theme.
 */
import { z } from "zod";
import { generateObject } from "../client";
import { untrusted } from "../untrusted";
import { FEATURES, SYNTHESIS_CLUSTER_SYSTEM, SYNTHESIS_MERGE_SYSTEM } from "../prompts";
import { batchBySize, truncate } from "../utils";
import type { Insight } from "./extractor";

const CLUSTER_BATCH_ITEMS = 150;
const CLUSTER_BATCH_CHARS = 30_000;
const MERGE_GROUP_SIZE = 60;
const MAX_MERGE_ROUNDS = 6;

export const clusterSchema = z.object({
  themes: z.array(z.object({ name: z.string(), description: z.string(), insightIds: z.array(z.string()) })),
});

export const mergeSchema = z.object({
  themes: z.array(z.object({ name: z.string(), description: z.string(), sourceThemeIds: z.array(z.string()) })),
});

export interface IndexedInsight extends Insight {
  ref: string;
}

export interface ThemeCandidate {
  name: string;
  description: string;
  insightRefs: string[];
}

interface LLMScope {
  orgId: string;
  projectId: string;
}

function cleanName(name: string): string {
  return truncate(name.replace(/\s+/g, " ").trim(), 120);
}

function cleanDescription(text: string): string {
  return truncate(text.trim(), 1_500);
}

async function clusterBatch(batch: IndexedInsight[], scope: LLMScope): Promise<ThemeCandidate[]> {
  const known = new Set(batch.map((i) => i.ref));
  const lines = batch.map(
    (i) => `${i.ref} [${i.kind}; severity ${i.severity}${i.productArea ? `; area: ${i.productArea}` : ""}] ${i.summary}`
  );
  const out = await generateObject({
    feature: FEATURES.synthesisCluster,
    orgId: scope.orgId,
    projectId: scope.projectId,
    system: SYNTHESIS_CLUSTER_SYSTEM,
    prompt: `Insights extracted from customer research (${batch.length}):\n\n${untrusted("extracted-insights", lines.join("\n"))}`,
    schema: clusterSchema,
    maxTokens: 12_000,
  });
  const assigned = new Set<string>();
  const themes: ThemeCandidate[] = [];
  for (const t of out.themes) {
    const refs = t.insightIds.map((r) => r.trim()).filter((r) => known.has(r) && !assigned.has(r));
    if (refs.length === 0 || !t.name.trim()) continue;
    refs.forEach((r) => assigned.add(r));
    themes.push({ name: cleanName(t.name), description: cleanDescription(t.description), insightRefs: refs });
  }
  return themes;
}

async function mergeGroup(group: ThemeCandidate[], scope: LLMScope): Promise<ThemeCandidate[]> {
  const labelled = group.map((t, i) => ({ id: `t${i + 1}`, theme: t }));
  const byId = new Map(labelled.map((l) => [l.id, l.theme]));
  const lines = labelled.map((l) => `${l.id} (${l.theme.insightRefs.length} insights): ${l.theme.name}. ${l.theme.description}`);
  const out = await generateObject({
    feature: FEATURES.synthesisMerge,
    orgId: scope.orgId,
    projectId: scope.projectId,
    system: SYNTHESIS_MERGE_SYSTEM,
    prompt: `Themes identified in separate batches (${group.length}):\n\n${untrusted("candidate-themes", lines.join("\n"))}`,
    schema: mergeSchema,
    maxTokens: 12_000,
  });
  const used = new Set<string>();
  const merged: ThemeCandidate[] = [];
  for (const t of out.themes) {
    const sources = t.sourceThemeIds.map((s) => s.trim()).filter((s) => byId.has(s) && !used.has(s));
    if (sources.length === 0 || !t.name.trim()) continue;
    sources.forEach((s) => used.add(s));
    const refs = [...new Set(sources.flatMap((s) => byId.get(s)!.insightRefs))];
    merged.push({ name: cleanName(t.name), description: cleanDescription(t.description), insightRefs: refs });
  }
  // Themes the model left out are kept as they are rather than silently lost.
  for (const l of labelled) if (!used.has(l.id)) merged.push(l.theme);
  return merged;
}

export interface ClusterResult {
  themes: ThemeCandidate[];
  batches: number;
  mergeRounds: number;
}

export async function clusterInsights(insights: IndexedInsight[], scope: LLMScope): Promise<ClusterResult> {
  if (insights.length === 0) return { themes: [], batches: 0, mergeRounds: 0 };
  const batches = batchBySize(insights, CLUSTER_BATCH_ITEMS, CLUSTER_BATCH_CHARS, (i) => i.summary.length + 60);
  let themes: ThemeCandidate[] = [];
  for (const batch of batches) themes.push(...(await clusterBatch(batch, scope)));

  let rounds = 0;
  if (batches.length > 1) {
    while (rounds < MAX_MERGE_ROUNDS) {
      rounds++;
      const groups: ThemeCandidate[][] = [];
      for (let i = 0; i < themes.length; i += MERGE_GROUP_SIZE) groups.push(themes.slice(i, i + MERGE_GROUP_SIZE));
      const merged: ThemeCandidate[] = [];
      for (const g of groups) merged.push(...(await mergeGroup(g, scope)));
      const progressed = merged.length < themes.length;
      themes = merged;
      if (groups.length === 1 || !progressed) break;
    }
  }
  return { themes, batches: batches.length, mergeRounds: rounds };
}
