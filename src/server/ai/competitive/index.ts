/**
 * Competitor scan (QUEUE.COMPETITIVE_SCAN).
 *
 * fetch pages → extract hashed sections → drop sections already seen
 * (CompetitorUpdate.contentHash, plus hashes of sections judged irrelevant kept
 * in metadata) → classify the new ones with the LLM → upsert updates on
 * (competitorId, contentHash) → alert org members on significant changes.
 *
 * The first scan of a competitor records a baseline without alerts. Failures
 * are recorded as failures (lastScanError, JobRun FAILED), never as "neutral".
 * Review data (G2) is not scraped: reviews are entered manually.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { emitEvent } from "../../events/bus";
import { failureMessage, NonRetryableError } from "../../jobs/worker";
import { notify } from "../../notifications/notify";
import { classifyCandidates, type ClassifiedUpdate } from "./analyzer";
import { extractCandidates, fetchCompetitorPages } from "./scanner";

/** New sections classified per scan; the rest are picked up by the next scan. */
export const MAX_CLASSIFY_PER_SCAN = 12;
const SEEN_HASHES_CAP = 500;
const MAX_ALERT_RECIPIENTS = 100;

interface ScanMetadata {
  seenHashes?: string[];
  lastRun?: Record<string, unknown>;
}

function readMeta(raw: unknown): { scan: ScanMetadata; rest: Record<string, unknown> } {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const scan = (obj.scan && typeof obj.scan === "object" ? obj.scan : {}) as ScanMetadata;
  return { scan: { seenHashes: Array.isArray(scan.seenHashes) ? scan.seenHashes.filter((h) => typeof h === "string") : [] }, rest: obj };
}

function isAlertWorthy(u: ClassifiedUpdate): boolean {
  return u.significance === "high" || (u.type === "PRICING" && u.significance === "medium");
}

export interface ScanResult {
  pagesFetched: number;
  pageErrors: number;
  newSections: number;
  classified: number;
  updatesCreated: number;
  alertsCreated: number;
  deferred: number;
  baseline: boolean;
}

export async function runCompetitorScan(data: { competitorId: string; jobRunId?: string }, log: Logger): Promise<ScanResult> {
  const competitor = await prisma.competitorProfile.findUnique({
    where: { id: data.competitorId },
    select: { id: true, orgId: true, name: true, website: true, captureUrl: true, metadata: true, lastScannedAt: true },
  });
  if (!competitor) throw new NonRetryableError("Competitor not found");
  if (data.jobRunId) {
    await prisma.jobRun.updateMany({
      where: { id: data.jobRunId, orgId: competitor.orgId, kind: "COMPETITIVE_SCAN", status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
  }
  if (!competitor.website && !competitor.captureUrl) throw new NonRetryableError("Add a website or a page to monitor before scanning");

  const { pages, errors } = await fetchCompetitorPages(competitor.website, competitor.captureUrl);
  if (pages.length === 0) {
    const reason = errors[0] ? `${errors[0].reason} (${errors[0].url})` : "no pages could be read";
    const message = `Couldn't read the competitor's website: ${reason}`;
    // Transient network trouble is retried; anything else is a final failure.
    if (errors.length > 0 && errors.every((e) => e.transient)) throw new Error(message);
    throw new NonRetryableError(message);
  }

  const candidates = extractCandidates(pages);
  const { scan, rest } = readMeta(competitor.metadata);
  const seen = new Set(scan.seenHashes);
  const existing = await prisma.competitorUpdate.findMany({
    where: { competitorId: competitor.id, contentHash: { in: candidates.map((c) => c.hash) } },
    select: { contentHash: true },
  });
  for (const e of existing) if (e.contentHash) seen.add(e.contentHash);
  const fresh = candidates.filter((c) => !seen.has(c.hash));
  const batch = fresh.slice(0, MAX_CLASSIFY_PER_SCAN);
  const deferred = fresh.length - batch.length;
  const baseline = competitor.lastScannedAt === null;

  const classified = await classifyCandidates({ orgId: competitor.orgId, competitorName: competitor.name }, batch);

  const created: Array<{ id: string; update: ClassifiedUpdate }> = [];
  const irrelevant: string[] = [];
  for (const u of classified) {
    if (!u.relevant) {
      irrelevant.push(u.candidate.hash);
      continue;
    }
    try {
      const row = await prisma.competitorUpdate.create({
        data: {
          competitorId: competitor.id,
          type: u.type,
          title: u.title,
          content: u.summary || u.candidate.text.slice(0, 1_000),
          sourceUrl: u.candidate.pageUrl,
          contentHash: u.candidate.hash,
          sentiment: u.sentiment,
          isManual: false,
        },
        select: { id: true },
      });
      created.push({ id: row.id, update: u });
    } catch (err) {
      // Already recorded by a previous attempt of this job: idempotent.
      if ((err as Prisma.PrismaClientKnownRequestError).code !== "P2002") throw err;
    }
  }
  // Sections the model didn't return stay unseen and are classified next time.

  let alertsCreated = 0;
  const alertWorthy = baseline ? [] : created.filter((c) => isAlertWorthy(c.update));
  if (alertWorthy.length > 0) {
    const members = await prisma.orgMember.findMany({
      where: { orgId: competitor.orgId, joinedAt: { not: null } },
      select: { userId: true },
      take: MAX_ALERT_RECIPIENTS,
    });
    const userIds = members.map((m) => m.userId);
    for (const { id, update } of alertWorthy) {
      const type = update.type === "PRICING" ? "PRICING_CHANGE" : update.type === "PRESS" ? "ANNOUNCEMENT" : "PRODUCT_UPDATE";
      const message = `${competitor.name}: ${update.title}`;
      await prisma.competitorAlert.createMany({ data: userIds.map((userId) => ({ competitorId: competitor.id, userId, type, message })) });
      alertsCreated += userIds.length;
      await notify({
        userIds,
        type: "COMPETITOR_ALERT",
        title: `${competitor.name}: ${update.title}`.slice(0, 200),
        message: update.summary.slice(0, 1_000),
        resourceType: "competitor",
        resourceId: competitor.id,
        href: `/competitive/${competitor.id}`,
        dedupeKey: `competitor-update:${id}`,
      });
    }
  }

  for (const { id, update } of created.slice(0, 20)) {
    await emitEvent({
      orgId: competitor.orgId,
      type: "competitor.updated",
      payload: { competitorId: competitor.id, updateId: id, type: update.type, title: update.title },
    });
  }

  const result: ScanResult = {
    pagesFetched: pages.length,
    pageErrors: errors.length,
    newSections: fresh.length,
    classified: classified.length,
    updatesCreated: created.length,
    alertsCreated,
    deferred,
    baseline,
  };
  const seenHashes = [...irrelevant, ...(scan.seenHashes ?? [])].filter((h, i, a) => a.indexOf(h) === i).slice(0, SEEN_HASHES_CAP);
  await prisma.competitorProfile.update({
    where: { id: competitor.id },
    data: {
      lastScannedAt: new Date(),
      lastScanError: null,
      metadata: { ...rest, scan: { seenHashes, lastRun: { ...result, at: new Date().toISOString() } } } as Prisma.InputJsonValue,
    },
  });
  if (data.jobRunId) {
    await prisma.jobRun.updateMany({
      where: { id: data.jobRunId, orgId: competitor.orgId },
      data: { status: "READY", output: result as unknown as Prisma.InputJsonValue, completedAt: new Date(), errorMessage: null },
    });
  }
  log.info("competitor scan completed", { competitorId: competitor.id, ...result });
  return result;
}

/** onFinalFailure: record the failure on the competitor and the JobRun. Idempotent. */
export async function markScanFailed(data: { competitorId: string; jobRunId?: string }, err: Error): Promise<void> {
  const message = failureMessage(err);
  await prisma.competitorProfile.updateMany({
    where: { id: data.competitorId },
    data: { lastScanError: message, lastScannedAt: new Date() },
  });
  if (data.jobRunId) {
    await prisma.jobRun.updateMany({
      where: { id: data.jobRunId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: message, completedAt: new Date() },
    });
  }
}
