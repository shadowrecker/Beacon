/**
 * Workflow runner, called by the QUEUE.WORKFLOWS worker.
 *
 * - One WorkflowRun per (workflow, event): the unique index means a redelivered
 *   event resumes or no-ops instead of running the workflow twice. Manual runs
 *   are tracked by their JobRun, whose output records the run ID.
 * - Actions run sequentially. Each action's params are re-validated against its
 *   schema at run time (stored JSON is never trusted), and its result is persisted
 *   as soon as it finishes, so a retry skips actions that already succeeded
 *   (idempotent side effects) and only re-attempts transient failures.
 * - The final status reflects reality: SUCCESS when every action succeeded or was
 *   skipped, PARTIAL_FAILURE when some failed, FAILED when all failed.
 * - Loop guards: events at causationDepth >= MAX_CAUSATION_DEPTH never run, and
 *   event-triggered runs are capped per workflow per hour.
 */
import { Prisma, type WorkflowRunStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { SafeFetchError } from "@/lib/safe-fetch";
import type { Payload, QUEUE } from "../jobs/queues";
import { isNonRetryable, NonRetryableError, type JobContext } from "../jobs/worker";
import { actionSchema, MAX_ACTIONS, MAX_CAUSATION_DEPTH, normalizeTriggerEvent, WORKFLOW_RUNS_PER_HOUR } from "./definitions";
import { executeAction, type ActionContext } from "./actions";

export interface ActionResult {
  index: number;
  type: string;
  status: "success" | "skipped" | "failed";
  message: string;
  output?: Record<string, string | number | boolean | null>;
  /** Failed with a transient error that a retry may fix. */
  retryable?: boolean;
  durationMs: number;
  finishedAt: string;
}

export const RUN_RATE_LIMIT = { name: "workflow-runs", limit: WORKFLOW_RUNS_PER_HOUR, windowMs: 3_600_000 } as const;

type WorkflowJob = Payload<typeof QUEUE.WORKFLOWS>;

/** User-presentable action error text. Upstream bodies never reach this. */
export function actionErrorMessage(err: unknown): string {
  if (err instanceof NonRetryableError) return err.message.slice(0, 300);
  if (err instanceof SafeFetchError) return err.message;
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") return `The provider returned status ${status}`;
  return "Unexpected error while running this action";
}

export function computeRunStatus(results: ActionResult[]): WorkflowRunStatus {
  const failed = results.filter((r) => r.status === "failed").length;
  if (failed === 0) return "SUCCESS";
  return failed === results.length ? "FAILED" : "PARTIAL_FAILURE";
}

function runSummary(results: ActionResult[]): string | null {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length === 0) return null;
  return `${failed.length} of ${results.length} action(s) failed: ${failed
    .map((r) => `#${r.index + 1} ${r.type}: ${r.message}`)
    .join("; ")}`.slice(0, 2_000);
}

async function loadWorkflow(workflowId: string) {
  return prisma.workflow.findUnique({
    where: { id: workflowId },
    select: {
      id: true,
      name: true,
      enabled: true,
      projectId: true,
      actions: true,
      project: { select: { id: true, name: true, orgId: true } },
    },
  });
}

async function finishJobRun(jobRunId: string | undefined, status: "READY" | "FAILED", output: Prisma.InputJsonValue, errorMessage: string | null) {
  if (!jobRunId) return;
  await prisma.jobRun.updateMany({
    where: { id: jobRunId, kind: "WORKFLOW_MANUAL_RUN" },
    data: { status, output, errorMessage, completedAt: new Date() },
  });
}

/** Create (or find) the run row for this job. Returns null when nothing should run. */
async function openRun(
  data: WorkflowJob,
  wf: NonNullable<Awaited<ReturnType<typeof loadWorkflow>>>,
  event: { id: string; payload: unknown; causationDepth: number } | null
) {
  if (data.eventId) {
    const existing = await prisma.workflowRun.findUnique({
      where: { workflowId_eventId: { workflowId: wf.id, eventId: data.eventId } },
    });
    if (existing) return existing;
    const limit = await checkRateLimit(RUN_RATE_LIMIT, wf.id);
    const base = {
      workflowId: wf.id,
      eventId: data.eventId,
      causationDepth: event?.causationDepth ?? 0,
      triggerData: event ? (event.payload as Prisma.InputJsonValue) : Prisma.JsonNull,
    };
    try {
      if (!limit.allowed) {
        return await prisma.workflowRun.create({
          data: {
            ...base,
            status: "FAILED",
            actionsExecuted: [],
            error: `Skipped: this workflow already ran ${WORKFLOW_RUNS_PER_HOUR} times in the last hour`,
            completedAt: new Date(),
          },
        });
      }
      return await prisma.workflowRun.create({ data: { ...base, status: "RUNNING", actionsExecuted: [] } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return prisma.workflowRun.findUnique({ where: { workflowId_eventId: { workflowId: wf.id, eventId: data.eventId } } });
      }
      throw err;
    }
  }

  // Manual run: the JobRun remembers which WorkflowRun it created.
  if (!data.jobRunId) throw new NonRetryableError("Manual workflow runs require a job");
  const jobRun = await prisma.jobRun.findFirst({
    where: { id: data.jobRunId, kind: "WORKFLOW_MANUAL_RUN", projectId: wf.projectId },
    select: { id: true, status: true, output: true },
  });
  if (!jobRun) throw new NonRetryableError("Job not found");
  const known = (jobRun.output as { runId?: unknown } | null)?.runId;
  if (typeof known === "string") {
    const run = await prisma.workflowRun.findFirst({ where: { id: known, workflowId: wf.id } });
    if (run) return run;
  }
  const run = await prisma.workflowRun.create({
    data: { workflowId: wf.id, eventId: null, causationDepth: 0, status: "RUNNING", actionsExecuted: [], triggerData: { manual: true } },
  });
  await prisma.jobRun.update({
    where: { id: jobRun.id },
    data: { status: "PROCESSING", startedAt: new Date(), output: { runId: run.id } },
  });
  return run;
}

export interface RunOutcome {
  runId: string | null;
  status: WorkflowRunStatus | "SKIPPED";
  duplicate?: boolean;
}

export async function runWorkflowJob(data: WorkflowJob, job: Pick<JobContext, "attempt" | "maxAttempts" | "log">): Promise<RunOutcome> {
  const log = job.log.child({ workflowId: data.workflowId, eventId: data.eventId });
  const wf = await loadWorkflow(data.workflowId);
  if (!wf) {
    await finishJobRun(data.jobRunId, "FAILED", {}, "The workflow was deleted");
    return { runId: null, status: "SKIPPED" };
  }

  let event: { id: string; type: ReturnType<typeof normalizeTriggerEvent>; payload: unknown; causationDepth: number } | null = null;
  if (data.eventId) {
    if (!wf.enabled) return { runId: null, status: "SKIPPED" };
    const row = await prisma.domainEvent.findUnique({
      where: { id: data.eventId },
      select: { id: true, orgId: true, projectId: true, type: true, payload: true, causationDepth: true },
    });
    // Defense in depth: the event must belong to the workflow's tenant.
    if (!row || row.orgId !== wf.project.orgId || (row.projectId !== null && row.projectId !== wf.projectId)) {
      throw new NonRetryableError("Triggering event not found for this workflow");
    }
    if (row.causationDepth >= MAX_CAUSATION_DEPTH) {
      log.warn("workflow skipped: causation depth limit", { depth: row.causationDepth });
      return { runId: null, status: "SKIPPED" };
    }
    event = { id: row.id, type: normalizeTriggerEvent(row.type), payload: row.payload, causationDepth: row.causationDepth };
  }

  const run = await openRun(data, wf, event);
  if (!run) throw new Error("Workflow run could not be opened");
  if (run.status !== "RUNNING") {
    // Already finished (redelivered event or retried manual job).
    await finishJobRun(data.jobRunId, run.status === "FAILED" ? "FAILED" : "READY", { runId: run.id, status: run.status }, run.status === "FAILED" ? run.error : null);
    return { runId: run.id, status: run.status, duplicate: true };
  }

  const rawActions = Array.isArray(wf.actions) ? (wf.actions as unknown[]).slice(0, MAX_ACTIONS) : [];
  const prior = new Map(((run.actionsExecuted ?? []) as unknown as ActionResult[]).map((r) => [r.index, r]));
  const results: ActionResult[] = [];
  let retryNeeded = false;

  const persist = () =>
    prisma.workflowRun.update({ where: { id: run.id }, data: { actionsExecuted: results as unknown as Prisma.InputJsonValue } });

  for (let i = 0; i < rawActions.length; i++) {
    const prev = prior.get(i);
    if (prev && !(prev.status === "failed" && prev.retryable)) {
      results.push(prev);
      continue;
    }
    const raw = rawActions[i] as { type?: unknown };
    const type = typeof raw?.type === "string" ? raw.type.slice(0, 40) : "UNKNOWN";
    const started = Date.now();
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) {
      results.push({ index: i, type, status: "failed", message: "Invalid action configuration; edit the workflow to fix it", retryable: false, durationMs: 0, finishedAt: new Date().toISOString() });
      await persist();
      continue;
    }
    const ctx: ActionContext = {
      runId: run.id,
      actionIndex: i,
      workflow: { id: wf.id, name: wf.name, projectId: wf.projectId },
      project: wf.project,
      event: event && event.type ? { id: event.id, type: event.type, payload: event.payload, causationDepth: event.causationDepth } : null,
      log: log.child({ action: type, index: i }),
    };
    try {
      const outcome = await executeAction(ctx, parsed.data);
      results.push({ index: i, type, status: outcome.status, message: outcome.message.slice(0, 300), output: outcome.output, durationMs: Date.now() - started, finishedAt: new Date().toISOString() });
    } catch (err) {
      const retryable = !isNonRetryable(err) && !(err instanceof SafeFetchError && err.code !== "TIMEOUT" && err.code !== "NETWORK");
      if (retryable) retryNeeded = true;
      ctx.log.warn("workflow action failed", { err, retryable });
      results.push({ index: i, type, status: "failed", message: actionErrorMessage(err), retryable, durationMs: Date.now() - started, finishedAt: new Date().toISOString() });
    }
    await persist();
  }

  if (retryNeeded && job.attempt < job.maxAttempts) {
    // Results are saved; the retry re-attempts only the transient failures.
    throw new Error("A workflow action failed with a temporary error; retrying");
  }

  const status = rawActions.length === 0 ? "FAILED" : computeRunStatus(results);
  const error = rawActions.length === 0 ? "The workflow has no actions" : runSummary(results);
  const finalResults = results.map((r) => ({ ...r, retryable: undefined }));
  await prisma.$transaction([
    prisma.workflowRun.update({
      where: { id: run.id },
      data: { status, error, completedAt: new Date(), actionsExecuted: finalResults as unknown as Prisma.InputJsonValue },
    }),
    prisma.workflow.update({ where: { id: wf.id }, data: { lastRunAt: new Date(), runCount: { increment: 1 } } }),
  ]);
  await finishJobRun(data.jobRunId, status === "FAILED" ? "FAILED" : "READY", { runId: run.id, status }, status === "FAILED" ? error : null);
  log.info("workflow run finished", { runId: run.id, status });
  return { runId: run.id, status };
}

/** Final-failure hook: move the run and its JobRun to FAILED. Idempotent. */
export async function failWorkflowJob(data: WorkflowJob, message: string): Promise<void> {
  let runId: string | null = null;
  if (data.eventId) {
    const run = await prisma.workflowRun.findUnique({
      where: { workflowId_eventId: { workflowId: data.workflowId, eventId: data.eventId } },
      select: { id: true },
    });
    runId = run?.id ?? null;
  } else if (data.jobRunId) {
    const jr = await prisma.jobRun.findUnique({ where: { id: data.jobRunId }, select: { output: true } });
    const known = (jr?.output as { runId?: unknown } | null)?.runId;
    runId = typeof known === "string" ? known : null;
  }
  if (runId) {
    await prisma.workflowRun.updateMany({
      where: { id: runId, status: "RUNNING" },
      data: { status: "FAILED", error: message.slice(0, 2_000), completedAt: new Date() },
    });
  }
  if (data.jobRunId) {
    await prisma.jobRun.updateMany({
      where: { id: data.jobRunId, status: { in: ["PENDING", "PROCESSING"] } },
      data: { status: "FAILED", errorMessage: message, completedAt: new Date() },
    });
  }
}
