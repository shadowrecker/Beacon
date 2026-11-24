/**
 * Synthesis run for one Synthesis row (created PENDING by synthesis.run).
 *
 * map:    per-document insight extraction (bulk tier, bounded windows)
 * reduce: clustering in bounded batches + hierarchical merge
 * score:  deterministic theme scores from the verified evidence
 * write:  themes + citations replace any previous themes of this synthesis in
 *         one transaction (idempotent on retry); the row moves to READY.
 *
 * Documents that fail extraction are recorded in the output (never silently
 * dropped); a run fails only when nothing could be analyzed.
 */
import type { Prisma, SynthesisType } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { emitEvent } from "@/server/events/bus";
import { failureMessage, NonRetryableError } from "@/server/jobs/worker";
import { LLMError, modelFor } from "../client";
import type { SkippedDocument, SynthesisOutput } from "../types";
import { mapWithConcurrency } from "../utils";
import { clusterInsights, type IndexedInsight } from "./clusterer";
import { extractDocumentInsights, type Insight, type InsightKind } from "./extractor";
import { scoreThemes } from "./scorer";

export const MAX_DOCUMENTS_PER_RUN = 200;
const MAX_CHUNKS_PER_DOCUMENT = 600;
const EXTRACTION_CONCURRENCY = 4;
const MAX_THEMES = 30;

const KINDS_FOR_TYPE: Record<SynthesisType, InsightKind[] | null> = {
  THEMES: null,
  FULL: null,
  PAIN_POINTS: ["pain_point"],
  FEATURE_REQUESTS: ["feature_request"],
};

/** Errors that will fail every document the same way: abort the run instead of skipping. */
function isRunFatal(err: unknown): boolean {
  if (err instanceof LLMError) return err.reason === "not_configured";
  return err instanceof NonRetryableError; // e.g. the org's token budget is exhausted
}

export interface SynthesisProgress {
  (pct: number): Promise<void>;
}

export async function runSynthesis(synthesisId: string, log: Logger, progress: SynthesisProgress = async () => undefined): Promise<{ themeCount: number } | null> {
  const synthesis = await prisma.synthesis.findUnique({
    where: { id: synthesisId },
    select: { id: true, projectId: true, type: true, status: true, createdById: true, causationDepth: true, project: { select: { orgId: true } } },
  });
  if (!synthesis) {
    log.warn("synthesis no longer exists; skipping", { synthesisId });
    return null;
  }
  if (synthesis.status === "READY") {
    return { themeCount: await prisma.theme.count({ where: { synthesisId } }) };
  }
  const { projectId } = synthesis;
  const orgId = synthesis.project.orgId;
  const scope = { orgId, projectId };

  await prisma.synthesis.update({
    where: { id: synthesisId },
    data: { status: "PROCESSING", startedAt: new Date(), errorMessage: null, completedAt: null },
  });

  const [documents, readyCount] = await Promise.all([
    prisma.document.findMany({
      where: { projectId, status: "READY" },
      orderBy: { createdAt: "desc" },
      take: MAX_DOCUMENTS_PER_RUN,
      select: { id: true, title: true },
    }),
    prisma.document.count({ where: { projectId, status: "READY" } }),
  ]);
  if (documents.length === 0) throw new NonRetryableError("There are no processed documents to analyze yet");

  const skipped: SkippedDocument[] = [];
  const partial: SynthesisOutput["partialDocuments"] = [];
  const insights: Insight[] = [];
  let analyzed = 0;
  let transientFailures = 0;
  let done = 0;

  await mapWithConcurrency(documents, EXTRACTION_CONCURRENCY, async (doc) => {
    const chunks = await prisma.chunk.findMany({
      where: { documentId: doc.id, projectId },
      orderBy: { position: "asc" },
      take: MAX_CHUNKS_PER_DOCUMENT,
      select: { id: true, content: true },
    });
    try {
      if (chunks.length === 0) {
        skipped.push({ documentId: doc.id, title: doc.title, reason: "The document has no text" });
        return;
      }
      const result = await extractDocumentInsights({ document: doc, chunks, ...scope });
      insights.push(...result.insights);
      analyzed++;
      if (result.analyzedChars < result.totalChars) {
        partial.push({
          documentId: doc.id,
          title: doc.title,
          reason: "Only the beginning of this long document was analyzed",
          analyzedChars: result.analyzedChars,
          totalChars: result.totalChars,
        });
      }
    } catch (err) {
      if (isRunFatal(err)) throw err;
      if (!(err instanceof LLMError)) transientFailures++;
      log.warn("document extraction failed; skipping", { documentId: doc.id, err });
      skipped.push({ documentId: doc.id, title: doc.title, reason: failureMessage(err) });
    } finally {
      done++;
      await progress(5 + Math.round((done / documents.length) * 60));
    }
  });

  if (analyzed === 0) {
    // All failures were model-level (refusals, invalid output): retrying won't help.
    if (transientFailures === 0) throw new NonRetryableError("None of the documents could be analyzed");
    throw new Error("None of the documents could be analyzed");
  }

  const allowed = KINDS_FOR_TYPE[synthesis.type];
  const indexed: IndexedInsight[] = insights
    .filter((i) => !allowed || allowed.includes(i.kind))
    .map((i, n) => ({ ...i, ref: `i${n + 1}` }));
  const byRef = new Map(indexed.map((i) => [i.ref, i]));

  const clustered = await clusterInsights(indexed, scope);
  await progress(85);
  const themes = scoreThemes(clustered.themes, byRef, analyzed).slice(0, MAX_THEMES);

  const created = await prisma.$transaction(
    async (tx) => {
      const current = await tx.synthesis.findUnique({ where: { id: synthesisId }, select: { id: true } });
      if (!current) return null;
      await tx.theme.deleteMany({ where: { synthesisId } });

      const citedIds = [...new Set(themes.flatMap((t) => t.citations.map((c) => c.chunkId)))];
      const liveChunks = new Set(
        (await tx.chunk.findMany({ where: { id: { in: citedIds }, projectId }, select: { id: true } })).map((c) => c.id)
      );

      const rows: Array<{ id: string; name: string; sentiment: string; confidenceScore: number }> = [];
      const stats: SynthesisOutput["themes"] = [];
      for (const t of themes) {
        const theme = await tx.theme.create({
          data: { synthesisId, name: t.name, description: t.description, sentiment: t.sentiment, confidenceScore: t.confidenceScore },
          select: { id: true, name: true, sentiment: true, confidenceScore: true },
        });
        const citations = t.citations.filter((c) => liveChunks.has(c.chunkId));
        if (citations.length > 0) {
          await tx.citation.createMany({
            data: citations.map((c) => ({ themeId: theme.id, chunkId: c.chunkId, quote: c.quote, relevanceScore: c.relevanceScore })),
          });
        }
        rows.push(theme);
        stats.push({
          themeId: theme.id,
          frequency: t.frequency,
          insightCount: t.insightCount,
          severity: t.severity,
          priorityScore: t.priorityScore,
          productAreas: t.productAreas,
          segments: t.segments,
        });
      }

      const output: SynthesisOutput = {
        version: 1,
        documentsConsidered: documents.length,
        documentsAnalyzed: analyzed,
        skippedDocuments: skipped,
        partialDocuments: partial,
        documentsNotIncluded: Math.max(0, readyCount - documents.length),
        insightCount: indexed.length,
        themeCount: rows.length,
        clusterBatches: clustered.batches,
        themes: stats,
      };
      await tx.synthesis.update({
        where: { id: synthesisId },
        data: {
          status: "READY",
          output: output as unknown as Prisma.InputJsonValue,
          modelUsed: `extract: ${modelFor("bulk")}; cluster: ${modelFor("default")}`,
          completedAt: new Date(),
          errorMessage: null,
        },
      });
      return rows;
    },
    { timeout: 60_000, maxWait: 10_000 }
  );

  if (!created) {
    log.warn("synthesis deleted during the run; discarded results", { synthesisId });
    return null;
  }

  await emitEvent({
    orgId,
    projectId,
    type: "synthesis.completed",
    payload: { synthesisId, themeCount: created.length },
    actorUserId: synthesis.createdById,
    // Workflow-triggered syntheses carry their chain depth (loop guard).
    causationDepth: synthesis.causationDepth,
  });
  for (const t of created) {
    await emitEvent({
      orgId,
      projectId,
      type: "theme.detected",
      payload: { synthesisId, themeId: t.id, name: t.name, sentiment: t.sentiment, confidence: t.confidenceScore },
      actorUserId: synthesis.createdById,
      causationDepth: synthesis.causationDepth,
    });
  }
  log.info("synthesis completed", { synthesisId, themes: created.length, analyzed, skipped: skipped.length });
  return { themeCount: created.length };
}

export async function markSynthesisFailed(synthesisId: string, err: Error): Promise<void> {
  const message = failureMessage(err);
  const res = await prisma.synthesis.updateMany({
    where: { id: synthesisId, status: { not: "READY" } },
    data: { status: "FAILED", errorMessage: message, completedAt: new Date() },
  });
  if (res.count === 0) return;
  const s = await prisma.synthesis.findUnique({
    where: { id: synthesisId },
    select: { projectId: true, createdById: true, causationDepth: true, project: { select: { orgId: true } } },
  });
  if (!s) return;
  await emitEvent({
    orgId: s.project.orgId,
    projectId: s.projectId,
    type: "synthesis.failed",
    payload: { synthesisId, error: message },
    actorUserId: s.createdById,
    causationDepth: s.causationDepth,
  });
}
