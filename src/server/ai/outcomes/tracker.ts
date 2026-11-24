/**
 * Outcome tracking: what happened after a recommendation shipped.
 *
 * - A recommendation reaching IMPLEMENTED starts tracking (status SHIPPED,
 *   shippedAt now) exactly once per recommendation, even when the event is
 *   delivered twice concurrently (transaction-scoped advisory lock).
 * - Progress toward target is computed in one place for the API and UI.
 */
import type { OutcomeStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { emitEvent } from "@/server/events/bus";

export const OUTCOME_STATUSES = ["NOT_SHIPPED", "SHIPPED", "MEASURING", "MEASURED"] as const satisfies readonly OutcomeStatus[];

export interface OutcomeValues {
  baselineValue: number | null;
  currentValue: number | null;
  targetValue: number | null;
}

/**
 * Fraction of the way from baseline to target (1 = target met, >1 exceeded,
 * <0 moved away). Direction-aware: works when lower is better. Null when it
 * can't be computed.
 */
export function computeProgress(v: OutcomeValues): number | null {
  const { baselineValue: b, currentValue: c, targetValue: t } = v;
  if (b === null || c === null || t === null) return null;
  if (t === b) return c === t ? 1 : null;
  const p = (c - b) / (t - b);
  return Number.isFinite(p) ? Math.round(p * 1000) / 1000 : null;
}

/**
 * Start tracking a recommendation that was implemented. Idempotent per
 * recommendation: an existing tracking row is reused (and promoted to SHIPPED
 * if it was NOT_SHIPPED). `orgId` must be the org the event was emitted in; the
 * recommendation must belong to a project of that org.
 */
export async function startTrackingForImplemented(
  input: { recommendationId: string; orgId: string; actorUserId?: string | null; causationDepth?: number }
): Promise<{ outcomeId: string; created: boolean } | null> {
  const rec = await prisma.recommendation.findFirst({
    where: { id: input.recommendationId, project: { orgId: input.orgId } },
    select: { id: true, projectId: true, status: true },
  });
  if (!rec || rec.status !== "IMPLEMENTED") return null;

  const result = await prisma.$transaction(async (tx) => {
    // Serialize concurrent deliveries for the same recommendation.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`outcome:${rec.id}`}))`;
    // One row per recommendation (@@unique on recommendationId).
    const existing = await tx.outcomeTracking.findUnique({
      where: { recommendationId: rec.id },
      select: { id: true, status: true, shippedAt: true },
    });
    if (existing) {
      if (existing.status === "NOT_SHIPPED") {
        await tx.outcomeTracking.update({
          where: { id: existing.id },
          data: { status: "SHIPPED", shippedAt: existing.shippedAt ?? new Date() },
        });
        return { outcomeId: existing.id, created: false, changed: true };
      }
      return { outcomeId: existing.id, created: false, changed: false };
    }
    const row = await tx.outcomeTracking.create({
      data: { recommendationId: rec.id, status: "SHIPPED", shippedAt: new Date() },
      select: { id: true },
    });
    return { outcomeId: row.id, created: true, changed: true };
  });

  if (result.changed) {
    await emitEvent({
      orgId: input.orgId,
      projectId: rec.projectId,
      type: "outcome.updated",
      payload: { outcomeId: result.outcomeId, recommendationId: rec.id, status: "SHIPPED" },
      actorUserId: input.actorUserId ?? null,
      causationDepth: (input.causationDepth ?? 0) + 1,
    });
  }
  return { outcomeId: result.outcomeId, created: result.created };
}
