/**
 * Worker for QUEUE.IMPORTS: integration-backed roadmap imports (JobRun kind
 * ROADMAP_IMPORT: Linear, Jira, Notion, Productboard) and analytics imports
 * (kind ANALYTICS_IMPORT: Amplitude, Mixpanel).
 *
 * - Updates the producer's JobRun (PENDING -> PROCESSING -> READY | FAILED) and
 *   never creates another tracking row.
 * - Re-verifies that the project, target roadmap and integration all belong to
 *   the run's org before fetching; credentials come from that org only.
 * - Idempotent on retry: roadmap items upsert on (roadmapId, externalId), a
 *   roadmap created by an earlier attempt is reused (its id is recorded in the
 *   run's output first), and an analytics import is stored in the same
 *   transaction that marks the run READY.
 * - Final failures store a user-presentable message, never upstream bodies.
 */
import type { IntegrationProvider, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { defineWorker, NonRetryableError } from "@/server/jobs/worker";
import {
  fetchIntegrationRoadmapItems,
  importFailureMessage,
  roadmapImportJobInputSchema,
  runRoadmapImport,
  SOURCE_LABEL,
} from "@/server/ai/roadmap/importer";
import {
  ANALYTICS_SOURCE_LABEL,
  analyticsImportJobInputSchema,
  fetchIntegrationAnalyticsPoints,
  saveAnalyticsImport,
} from "@/server/ai/analytics/importer";

interface RoadmapProgress {
  phase: "importing";
  roadmapId: string;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

function readProgress(output: Prisma.JsonValue | null): RoadmapProgress | null {
  const o = output as Partial<RoadmapProgress> | null;
  return o && o.phase === "importing" && typeof o.roadmapId === "string" ? { phase: "importing", roadmapId: o.roadmapId } : null;
}

/** Label for messages, from the run's stored input (never throws). */
function labelOf(kind: string, input: Prisma.JsonValue | null): string {
  const source = (input as { source?: unknown } | null)?.source;
  if (kind === "ROADMAP_IMPORT" && typeof source === "string" && source in SOURCE_LABEL) {
    return SOURCE_LABEL[source as keyof typeof SOURCE_LABEL];
  }
  if (kind === "ANALYTICS_IMPORT" && typeof source === "string" && source in ANALYTICS_SOURCE_LABEL) {
    return ANALYTICS_SOURCE_LABEL[source as keyof typeof ANALYTICS_SOURCE_LABEL];
  }
  return "The integration";
}

async function requireConnected(orgId: string, provider: IntegrationProvider, label: string, integrationId?: string) {
  const integ = await prisma.integration.findFirst({
    where: { orgId, provider, ...(integrationId ? { id: integrationId } : {}) },
    select: { id: true, status: true },
  });
  if (!integ) throw new NonRetryableError(`${label} is not connected for this workspace`);
  if (integ.status !== "CONNECTED") throw new NonRetryableError(`${label} is not connected. Reconnect it and try again.`);
  return integ;
}

export const importWorker = defineWorker({
  queue: QUEUE.IMPORTS,
  concurrency: 2,
  handler: async ({ jobRunId }, ctx) => {
    const run = await prisma.jobRun.findUnique({
      where: { id: jobRunId },
      select: { id: true, kind: true, status: true, orgId: true, projectId: true, input: true, output: true },
    });
    if (!run || (run.kind !== "ROADMAP_IMPORT" && run.kind !== "ANALYTICS_IMPORT") || !run.projectId) {
      throw new NonRetryableError("Import not found");
    }
    if (run.status === "READY" || run.status === "FAILED") return { status: run.status, skipped: true };

    // The project must still belong to the org the run was created in.
    const project = await prisma.project.findUnique({ where: { id: run.projectId }, select: { id: true, orgId: true } });
    if (!project || project.orgId !== run.orgId) throw new NonRetryableError("The project for this import no longer exists");

    await prisma.jobRun.update({ where: { id: run.id }, data: { status: "PROCESSING", startedAt: new Date(), errorMessage: null } });
    await ctx.updateProgress(10);

    if (run.kind === "ROADMAP_IMPORT") {
      const parsed = roadmapImportJobInputSchema.safeParse(run.input);
      if (!parsed.success) throw new NonRetryableError("Invalid import request");
      const params = parsed.data;
      const label = SOURCE_LABEL[params.source];
      await requireConnected(project.orgId, params.source, label);

      // Target: the requested roadmap, or the one an earlier attempt created.
      const progress = readProgress(run.output);
      const targetId = params.roadmapId ?? progress?.roadmapId ?? null;
      if (targetId) {
        const roadmap = await prisma.roadmap.findFirst({ where: { id: targetId, projectId: project.id }, select: { id: true } });
        if (!roadmap) throw new NonRetryableError("The roadmap to import into no longer exists");
      }

      const result = await runRoadmapImport({
        projectId: project.id,
        source: params.source,
        roadmapId: targetId,
        name: params.name,
        load: () => fetchIntegrationRoadmapItems(project.orgId, params),
        onRoadmapCreated: async (roadmapId) => {
          await prisma.jobRun.update({ where: { id: run.id }, data: { output: json({ phase: "importing", roadmapId }) } });
        },
      });
      await prisma.jobRun.update({
        where: { id: run.id },
        data: { status: "READY", output: json({ kind: "ROADMAP_IMPORT", ...result }), completedAt: new Date(), errorMessage: null },
      });
      return result;
    }

    const parsed = analyticsImportJobInputSchema.safeParse(run.input);
    if (!parsed.success) throw new NonRetryableError("Invalid import request");
    const params = parsed.data;
    const label = ANALYTICS_SOURCE_LABEL[params.source];
    const integ = await requireConnected(project.orgId, params.source, label, params.integrationId);

    const fetched = await fetchIntegrationAnalyticsPoints(project.orgId, params);
    await ctx.updateProgress(70);
    // Store the import and finish the run atomically, so a retry can't store it twice.
    const result = await prisma.$transaction(async (tx) => {
      const saved = await saveAnalyticsImport(tx, {
        projectId: project.id,
        source: params.source,
        integrationId: integ.id,
        points: fetched.points,
        skipped: fetched.skipped,
        truncated: fetched.truncated,
      });
      await tx.jobRun.update({
        where: { id: run.id },
        data: {
          status: "READY",
          output: json({ kind: "ANALYTICS_IMPORT", importId: saved.importId, source: saved.source, summary: saved.summary }),
          completedAt: new Date(),
          errorMessage: null,
        },
      });
      return saved;
    });
    return { importId: result.importId, summary: result.summary };
  },
  onFinalFailure: async ({ jobRunId }, error) => {
    const run = await prisma.jobRun.findUnique({ where: { id: jobRunId }, select: { kind: true, input: true } });
    if (!run) return;
    await prisma.jobRun.updateMany({
      where: { id: jobRunId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: importFailureMessage(error, labelOf(run.kind, run.input)), completedAt: new Date() },
    });
  },
});
