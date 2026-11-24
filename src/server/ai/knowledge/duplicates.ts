/**
 * Duplicate-entity detection. Deterministic: for each recently touched entity,
 * an ANN query (HNSW, cosine) over the same org's entities embedded with the
 * same model returns the nearest neighbours; pairs above the similarity
 * threshold become KnowledgeMergeSuggestion rows for a human to review.
 * Nothing is merged automatically.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { embeddingModel } from "../embeddings";

export const DUPLICATE_SIMILARITY_THRESHOLD = Number(process.env.KG_DUPLICATE_THRESHOLD ?? "0.9");
/** Entities checked per run (a document touching more is checked on later runs). */
export const MAX_DUPLICATE_CHECKS = 100;

let iterativeScanSupported = true;

/**
 * Nearest neighbours of one entity within its org. Uses pgvector's iterative
 * index scan when available so the org filter does not starve the result set.
 */
export async function nearestEntities(orgId: string, entityId: string, model: string): Promise<Array<{ id: string; similarity: number }>> {
  const query = (db: Prisma.TransactionClient | typeof prisma) => db.$queryRaw<Array<{ id: string; similarity: number }>>`
    SELECT other.id, (1 - (other.embedding <=> me.embedding))::float8 AS similarity
    FROM knowledge_entities me
    CROSS JOIN LATERAL (
      SELECT o.id, o.embedding FROM knowledge_entities o
      WHERE o."orgId" = ${orgId} AND o.id <> me.id
        AND o.embedding IS NOT NULL AND o."embeddingModel" = ${model}
      ORDER BY o.embedding <=> me.embedding
      LIMIT 6
    ) other
    WHERE me.id = ${entityId} AND me."orgId" = ${orgId}
      AND me.embedding IS NOT NULL AND me."embeddingModel" = ${model}`;

  if (iterativeScanSupported) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);
        return query(tx);
      });
    } catch (err) {
      // Older pgvector (< 0.8) has no iterative scans: fall back to a plain index scan.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/iterative_scan|unrecognized configuration parameter/i.test(msg)) throw err;
      iterativeScanSupported = false;
    }
  }
  return query(prisma);
}

/** Record merge suggestions for likely duplicates of `entityIds`. Returns how many were created. */
export async function suggestMerges(orgId: string, entityIds: string[], log?: Logger): Promise<number> {
  if (entityIds.length === 0) return 0;
  const model = embeddingModel();
  let created = 0;
  for (const id of entityIds.slice(0, MAX_DUPLICATE_CHECKS)) {
    const neighbours = (await nearestEntities(orgId, id, model))
      .filter((n) => n.similarity >= DUPLICATE_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
    for (const n of neighbours) {
      const pair = await prisma.knowledgeEntity.findMany({
        where: { id: { in: [id, n.id] }, orgId },
        select: { id: true, mentionCount: true, createdAt: true },
      });
      if (pair.length !== 2) continue;
      // Deterministic direction: keep the better-established entity as the target.
      const [target, source] = [...pair].sort(
        (a, b) => b.mentionCount - a.mentionCount || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
      );
      const existing = await prisma.knowledgeMergeSuggestion.findFirst({
        where: {
          orgId,
          OR: [
            { sourceId: source.id, targetId: target.id },
            { sourceId: target.id, targetId: source.id },
          ],
        },
        select: { id: true },
      });
      if (existing) continue;
      try {
        await prisma.knowledgeMergeSuggestion.create({
          data: { orgId, sourceId: source.id, targetId: target.id, similarity: Math.round(n.similarity * 1000) / 1000 },
        });
        created++;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // concurrent insert
        throw err;
      }
    }
  }
  if (created > 0) log?.info("knowledge merge suggestions created", { orgId, created });
  return created;
}
