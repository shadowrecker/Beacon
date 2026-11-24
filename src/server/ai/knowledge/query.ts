/**
 * Natural-language questions over an org's knowledge graph.
 *
 * Retrieval: embed the question, take the nearest entities in the org (same
 * embedding model), then their strongest relations among each other and to
 * direct neighbours (bounded). The model answers from that context only and
 * cites entities by label (E1..En); labels are mapped back to IDs and any
 * citation outside the retrieved set is discarded. The question and result are
 * stored as a KnowledgeQuery.
 */
import type { EntityType, Prisma, RelationType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { generateObject } from "../client";
import { embeddingModel, embedText, toVectorLiteral } from "../embeddings";
import { UNTRUSTED_DATA_POLICY, untrusted } from "../untrusted";
import { parseQuotes } from "./store";

export const KNOWLEDGE_QUERY_FEATURE = "knowledge.query";
const SEED_ENTITIES = 12;
const MAX_CONTEXT_ENTITIES = 40;
const MAX_CONTEXT_RELATIONS = 80;

export interface QueryEntity {
  id: string;
  name: string;
  type: EntityType;
  mentionCount: number;
}

export interface KnowledgeAnswer {
  queryId: string;
  answer: string;
  confidence: number;
  citedEntities: QueryEntity[];
  insights: string[];
  retrievedCount: number;
}

const answerSchema = z.object({
  answer: z.string().describe("Answer in 1-3 short paragraphs, grounded only in the provided graph"),
  citedEntities: z.array(z.string()).describe("Labels (E1, E2, ...) of the entities the answer relies on"),
  insights: z.array(z.string()).describe("Up to 3 short follow-up observations"),
  confidence: z.number().describe("0 to 1: how well the graph supports the answer"),
});

const SYSTEM = `You answer product questions using a knowledge graph built from customer feedback.
You receive entities (labelled E1, E2, ...) and relations between them, with short supporting quotes.
Answer only from that material. If it does not contain the answer, say so plainly and keep confidence low.
Cite the entities you rely on by their labels in citedEntities. Do not invent entities, numbers or quotes.

${UNTRUSTED_DATA_POLICY}`;

async function nearestToVector(orgId: string, vector: number[], model: string): Promise<Array<{ id: string; similarity: number }>> {
  return prisma.$queryRaw<Array<{ id: string; similarity: number }>>`
    SELECT id, (1 - (embedding <=> ${toVectorLiteral(vector)}::vector))::float8 AS similarity
    FROM knowledge_entities
    WHERE "orgId" = ${orgId} AND embedding IS NOT NULL AND "embeddingModel" = ${model}
    ORDER BY embedding <=> ${toVectorLiteral(vector)}::vector
    LIMIT ${SEED_ENTITIES}`;
}

export async function answerKnowledgeQuestion(input: { orgId: string; userId: string; question: string }): Promise<KnowledgeAnswer> {
  const { orgId, userId, question } = input;
  const model = embeddingModel();
  const hasEmbedded = await prisma.knowledgeEntity.count({ where: { orgId, embeddingModel: model } });

  let seeds: Array<{ id: string; similarity: number }> = [];
  if (hasEmbedded > 0) {
    const { vector, model: used } = await embedText(question, { feature: "knowledge.query.embed", orgId });
    seeds = await nearestToVector(orgId, vector, used);
  }
  // Keyword fallback so exact names are found even when similarity is low.
  const words = question.match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu)?.slice(0, 8) ?? [];
  if (words.length > 0) {
    const byName = await prisma.knowledgeEntity.findMany({
      where: { orgId, OR: words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })) },
      orderBy: { mentionCount: "desc" },
      take: 6,
      select: { id: true },
    });
    for (const r of byName) if (!seeds.some((s) => s.id === r.id)) seeds.push({ id: r.id, similarity: 0 });
  }

  if (seeds.length === 0) {
    const empty = "There is no knowledge graph data for this workspace yet. Upload or sync customer feedback, and entities will be extracted automatically.";
    const row = await prisma.knowledgeQuery.create({
      data: { orgId, userId, query: question, results: { answer: empty, citedEntityIds: [], retrievedEntityIds: [], confidence: 0, insights: [] } },
      select: { id: true },
    });
    return { queryId: row.id, answer: empty, confidence: 0, citedEntities: [], insights: [], retrievedCount: 0 };
  }

  const seedIds = seeds.map((s) => s.id);
  const relations = await prisma.knowledgeRelation.findMany({
    where: {
      OR: [{ sourceId: { in: seedIds } }, { targetId: { in: seedIds } }],
      source: { orgId },
      target: { orgId },
    },
    orderBy: [{ strength: "desc" }, { id: "asc" }],
    take: MAX_CONTEXT_RELATIONS,
    select: { sourceId: true, targetId: true, type: true, strength: true, evidenceQuotes: true },
  });
  const contextIds = [...new Set([...seedIds, ...relations.flatMap((r) => [r.sourceId, r.targetId])])].slice(0, MAX_CONTEXT_ENTITIES);
  const entities = await prisma.knowledgeEntity.findMany({
    where: { id: { in: contextIds }, orgId },
    select: { id: true, name: true, type: true, description: true, mentionCount: true },
  });
  const order = new Map(contextIds.map((id, i) => [id, i]));
  entities.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const labelOf = new Map(entities.map((e, i) => [e.id, `E${i + 1}`]));
  const byLabel = new Map(entities.map((e, i) => [`e${i + 1}`, e]));

  const entityLines = entities.map(
    (e) => `${labelOf.get(e.id)} [${e.type}, ${e.mentionCount} mentions]: ${e.name}${e.description ? ` - ${e.description}` : ""}`
  );
  const relationLines = relations
    .filter((r) => labelOf.has(r.sourceId) && labelOf.has(r.targetId))
    .map((r) => {
      const quote = parseQuotes(r.evidenceQuotes)[0]?.quote;
      return `${labelOf.get(r.sourceId)} ${r.type as RelationType} ${labelOf.get(r.targetId)} (strength ${r.strength.toFixed(2)})${quote ? `: "${quote.slice(0, 200)}"` : ""}`;
    });

  const prompt = [
    `Question: ${question}`,
    "Entities:",
    untrusted("knowledge-entities", entityLines.join("\n")),
    "Relations:",
    untrusted("knowledge-relations", relationLines.join("\n") || "(none)"),
  ].join("\n\n");

  const raw = await generateObject({
    feature: KNOWLEDGE_QUERY_FEATURE,
    orgId,
    system: SYSTEM,
    prompt,
    schema: answerSchema,
    maxTokens: 4_000,
    effort: "medium",
  });

  const cited = [...new Set(raw.citedEntities.map((l) => l.trim().toLowerCase()))]
    .map((l) => byLabel.get(l))
    .filter((e): e is NonNullable<typeof e> => !!e);
  const answer = raw.answer.trim().slice(0, 6_000);
  const insights = raw.insights.map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 3);
  const confidence = Math.min(1, Math.max(0, Number.isFinite(raw.confidence) ? raw.confidence : 0));

  const row = await prisma.knowledgeQuery.create({
    data: {
      orgId,
      userId,
      query: question,
      results: {
        answer,
        confidence,
        insights,
        citedEntityIds: cited.map((e) => e.id),
        retrievedEntityIds: entities.map((e) => e.id),
      } satisfies Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    queryId: row.id,
    answer,
    confidence,
    insights,
    citedEntities: cited.map((e) => ({ id: e.id, name: e.name, type: e.type, mentionCount: e.mentionCount })),
    retrievedCount: entities.length,
  };
}

const storedResultSchema = z.object({
  answer: z.string().catch(""),
  confidence: z.number().catch(0),
  insights: z.array(z.string()).catch([]),
  citedEntityIds: z.array(z.string()).catch([]),
});

export function parseStoredResult(value: unknown): z.infer<typeof storedResultSchema> | null {
  const p = storedResultSchema.safeParse(value);
  return p.success ? p.data : null;
}
