/**
 * Entity/relation extraction for one bounded batch of chunks.
 *
 * Each chunk is labelled C1..Cn in the prompt and wrapped as untrusted data. The
 * model refers to chunks only by label; labels are mapped back to chunk IDs
 * here (model output never chooses IDs). Every relation must carry a quote that
 * is verified to be a substring of the cited chunk, otherwise it is dropped.
 */
import { EntityType, RelationType } from "@prisma/client";
import { z } from "zod";
import { generateObject } from "../client";
import { UNTRUSTED_DATA_POLICY, untrusted } from "../untrusted";
import { clamp01, cleanDisplayName, normalizeEntityName, uniqueCapped, verifyQuote } from "./text";

export const KNOWLEDGE_EXTRACT_FEATURE = "knowledge.extract";

/** Batch bounds: at most this many chunks / characters per model call. */
export const BATCH_MAX_CHUNKS = 8;
export const BATCH_MAX_CHARS = 14_000;
/** Chunks larger than this are not sent to the model (recorded as skipped). */
export const MAX_CHUNK_CHARS = 24_000;
const MAX_ENTITIES_PER_BATCH = 40;
const MAX_RELATIONS_PER_BATCH = 60;
const MAX_ALIASES = 10;

export interface BatchChunk {
  id: string;
  content: string;
}

export interface ExtractedEntity {
  key: string; // `${normalizedName}|${type}`
  name: string;
  normalizedName: string;
  type: EntityType;
  description: string | null;
  aliases: string[];
  confidence: number;
  chunkIds: string[];
}

export interface ExtractedEvidence {
  chunkId: string;
  quote: string;
}

export interface ExtractedRelation {
  sourceKey: string;
  targetKey: string;
  type: RelationType;
  strength: number;
  evidence: ExtractedEvidence[];
}

export interface BatchExtraction {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  /** Relations dropped because no quote could be verified against the chunk text. */
  unverifiedRelations: number;
}

const extractionSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().describe("Specific canonical name as written in the text"),
      type: z.enum(EntityType),
      description: z.string().describe("One short sentence describing the entity, grounded in the text"),
      aliases: z.array(z.string()).describe("Other names used for the same entity in the text"),
      chunkRefs: z.array(z.string()).describe("Labels of the chunks that mention the entity, e.g. C1"),
      confidence: z.number().describe("0 to 1"),
    })
  ),
  relations: z.array(
    z.object({
      source: z.string().describe("Name of the source entity, exactly as given in entities"),
      target: z.string().describe("Name of the target entity, exactly as given in entities"),
      type: z.enum(RelationType),
      strength: z.number().describe("0 to 1"),
      chunkRef: z.string().describe("Label of the chunk containing the supporting quote"),
      quote: z.string().describe("Verbatim excerpt (copied exactly, 8-300 characters) from that chunk"),
    })
  ),
});

const SYSTEM = `You build a product knowledge graph from customer feedback (interviews, tickets, call transcripts, notes).

Extract the significant entities and the relationships between them.
Entity types: PERSON (named individuals), COMPANY (customer or partner organizations), PRODUCT, FEATURE (product capabilities), CONCEPT, PAIN_POINT (problems users face), PERSONA (user roles), COMPETITOR, USE_CASE.
Relation types: MENTIONS, RELATES_TO, CAUSES, SOLVES, COMPETES_WITH, USED_BY, PART_OF, SIMILAR_TO, CONFLICTS_WITH.

Rules:
- Use specific names, not generic words ("Slack integration", not "integration"). Skip trivial or generic entities.
- Each chunk is labelled (C1, C2, ...). Cite chunks only by those labels.
- Every relation must include a quote copied verbatim from the cited chunk that supports it. If you cannot quote it, omit the relation.
- Relation source and target must both appear in your entities list.
- Report at most ${MAX_ENTITIES_PER_BATCH} entities and ${MAX_RELATIONS_PER_BATCH} relations; prefer the most important.
- Confidence and strength are numbers between 0 and 1.

${UNTRUSTED_DATA_POLICY}`;

function buildPrompt(batch: BatchChunk[], documentLabel: string): string {
  const parts = batch.map((c, i) => untrusted(`C${i + 1}`, c.content));
  return `Document title:\n${untrusted("document-title", documentLabel.slice(0, 300))}\n\nExtract entities and relations from these ${batch.length} chunks.\n\n${parts.join("\n\n")}`;
}

/** Split chunks into batches bounded by count and characters (order preserved). */
export function planBatches<T extends BatchChunk>(chunks: T[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const c of chunks) {
    const len = c.content.length;
    if (current.length > 0 && (current.length >= BATCH_MAX_CHUNKS || chars + len > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(c);
    chars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Map raw model output to validated entities/relations with real chunk IDs. */
export function validateExtraction(raw: z.infer<typeof extractionSchema>, batch: BatchChunk[]): BatchExtraction {
  const byLabel = new Map<string, BatchChunk>(batch.map((c, i) => [`c${i + 1}`, c]));
  const resolveRef = (ref: string) => byLabel.get(ref.trim().toLowerCase().replace(/^chunk\s*/, ""));

  const entities = new Map<string, ExtractedEntity>();
  const byName = new Map<string, string>(); // normalizedName -> entity key (first type wins)

  for (const e of raw.entities) {
    if (entities.size >= MAX_ENTITIES_PER_BATCH) break;
    const name = cleanDisplayName(e.name);
    const normalizedName = normalizeEntityName(name);
    if (normalizedName.length < 2) continue;
    let chunkIds = uniqueCapped(
      e.chunkRefs.map(resolveRef).filter((c): c is BatchChunk => !!c).map((c) => c.id),
      BATCH_MAX_CHUNKS
    );
    if (chunkIds.length === 0) {
      // Fall back to chunks that literally contain the name.
      chunkIds = batch.filter((c) => c.content.toLowerCase().includes(normalizedName)).map((c) => c.id);
    }
    if (chunkIds.length === 0) continue; // not grounded in this batch
    const key = `${normalizedName}|${e.type}`;
    const existing = entities.get(key);
    const aliases = uniqueCapped(
      e.aliases.map(cleanDisplayName).filter((a) => a.length > 1 && normalizeEntityName(a) !== normalizedName),
      MAX_ALIASES,
      (a) => normalizeEntityName(a)
    );
    if (existing) {
      existing.chunkIds = uniqueCapped([...existing.chunkIds, ...chunkIds], BATCH_MAX_CHUNKS);
      existing.aliases = uniqueCapped([...existing.aliases, ...aliases], MAX_ALIASES, (a) => normalizeEntityName(a));
      existing.confidence = Math.max(existing.confidence, clamp01(e.confidence));
      continue;
    }
    const description = e.description.replace(/\s+/g, " ").trim().slice(0, 500);
    entities.set(key, {
      key,
      name,
      normalizedName,
      type: e.type,
      description: description || null,
      aliases,
      confidence: clamp01(e.confidence),
      chunkIds,
    });
    if (!byName.has(normalizedName)) byName.set(normalizedName, key);
  }
  // Aliases also resolve relation endpoints.
  for (const ent of entities.values()) {
    for (const a of ent.aliases) {
      const n = normalizeEntityName(a);
      if (!byName.has(n)) byName.set(n, ent.key);
    }
  }

  const relations = new Map<string, ExtractedRelation>();
  let unverified = 0;
  for (const r of raw.relations) {
    if (relations.size >= MAX_RELATIONS_PER_BATCH) break;
    const sourceKey = byName.get(normalizeEntityName(r.source));
    const targetKey = byName.get(normalizeEntityName(r.target));
    if (!sourceKey || !targetKey || sourceKey === targetKey) continue;

    // Verify the quote against the cited chunk, then (if the label was wrong) any chunk in the batch.
    const cited = resolveRef(r.chunkRef);
    const candidates = cited ? [cited, ...batch.filter((c) => c !== cited)] : batch;
    let evidence: ExtractedEvidence | null = null;
    for (const c of candidates) {
      const q = verifyQuote(r.quote, c.content);
      if (q) {
        evidence = { chunkId: c.id, quote: q };
        break;
      }
    }
    if (!evidence) {
      unverified++;
      continue;
    }
    const key = `${sourceKey}>${targetKey}>${r.type}`;
    const existing = relations.get(key);
    if (existing) {
      existing.strength = Math.max(existing.strength, clamp01(r.strength));
      if (!existing.evidence.some((x) => x.chunkId === evidence!.chunkId && x.quote === evidence!.quote)) {
        existing.evidence.push(evidence);
      }
      continue;
    }
    relations.set(key, { sourceKey, targetKey, type: r.type, strength: clamp01(r.strength), evidence: [evidence] });
  }

  return { entities: [...entities.values()], relations: [...relations.values()], unverifiedRelations: unverified };
}

export async function extractBatch(
  batch: BatchChunk[],
  ctx: { orgId: string; projectId: string; documentLabel: string }
): Promise<BatchExtraction> {
  const raw = await generateObject({
    feature: KNOWLEDGE_EXTRACT_FEATURE,
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    system: SYSTEM,
    prompt: buildPrompt(batch, ctx.documentLabel),
    schema: extractionSchema,
    tier: "bulk",
    maxTokens: 8_000,
  });
  return validateExtraction(raw, batch);
}
