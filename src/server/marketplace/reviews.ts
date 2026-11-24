/**
 * Marketplace reviews: one review per user per connector (upsert on the unique
 * key) and one "helpful" vote per user per review. Aggregates (rating average and
 * count, helpful count) are recomputed from the rows inside the same transaction,
 * with the parent row locked, so concurrent writes can't inflate or skew them.
 */
import { prisma } from "@/lib/db";

export interface ReviewInput {
  connectorId: string;
  userId: string;
  orgId: string;
  rating: number;
  title?: string | null;
  content?: string | null;
}

export async function upsertReview(input: ReviewInput): Promise<{ reviewId: string; ratingAverage: number; ratingCount: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM marketplace_connectors WHERE id = ${input.connectorId} FOR UPDATE`;
    const review = await tx.connectorReview.upsert({
      where: { connectorId_userId: { connectorId: input.connectorId, userId: input.userId } },
      create: {
        connectorId: input.connectorId,
        userId: input.userId,
        orgId: input.orgId,
        rating: input.rating,
        title: input.title ?? null,
        content: input.content ?? null,
      },
      update: { rating: input.rating, title: input.title ?? null, content: input.content ?? null, orgId: input.orgId },
      select: { id: true },
    });
    const agg = await recomputeRating(tx, input.connectorId);
    return { reviewId: review.id, ...agg };
  });
}

export async function deleteReview(connectorId: string, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM marketplace_connectors WHERE id = ${connectorId} FOR UPDATE`;
    const res = await tx.connectorReview.deleteMany({ where: { connectorId, userId } });
    await recomputeRating(tx, connectorId);
    return res.count > 0;
  });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function recomputeRating(tx: Tx, connectorId: string): Promise<{ ratingAverage: number; ratingCount: number }> {
  const agg = await tx.connectorReview.aggregate({ where: { connectorId }, _avg: { rating: true }, _count: { _all: true } });
  const ratingCount = agg._count._all;
  const ratingAverage = ratingCount > 0 ? Math.round((agg._avg.rating ?? 0) * 100) / 100 : 0;
  await tx.marketplaceConnector.update({ where: { id: connectorId }, data: { ratingAverage, ratingCount } });
  return { ratingAverage, ratingCount };
}

/** Set or clear the caller's helpful vote; returns the recomputed count. */
export async function setHelpfulVote(reviewId: string, userId: string, helpful: boolean): Promise<{ helpful: number; voted: boolean }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM connector_reviews WHERE id = ${reviewId} FOR UPDATE`;
    if (helpful) {
      await tx.connectorReviewVote.upsert({
        where: { reviewId_userId: { reviewId, userId } },
        create: { reviewId, userId },
        update: {},
      });
    } else {
      await tx.connectorReviewVote.deleteMany({ where: { reviewId, userId } });
    }
    const count = await tx.connectorReviewVote.count({ where: { reviewId } });
    await tx.connectorReview.update({ where: { id: reviewId }, data: { helpful: count } });
    return { helpful: count, voted: helpful };
  });
}
