/**
 * Workflow automation router.
 *
 * - Access: reading requires project:read; every write requires
 *   workflows:manage on the workflow's project (VIEWERs cannot create, edit,
 *   delete or run workflows).
 * - Definitions are validated per action type (definitions.ts) and for foreign
 *   IDs and self-triggering loops (service.ts) at create/update/install time.
 * - runManually never executes inline: it creates a JobRun
 *   (WORKFLOW_MANUAL_RUN) and enqueues the run; the client polls job.get.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, orgProcedure, llmProcedure } from "../trpc";
import { can, found, requireProjectAccess } from "../auth/access";
import { assertCanCreate } from "../usage/entitlements";
import { enqueue, QUEUE } from "../jobs/queues";
import {
  ACTION_META,
  actionsSchema,
  normalizeTriggerEvent,
  triggerSchema,
  TRIGGER_EVENTS,
} from "../workflows/definitions";
import { toJson, validateDefinition } from "../workflows/service";
import { getWorkflowTemplate, WORKFLOW_TEMPLATES } from "../workflows/templates";

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1, "Name is required").max(120, "Name must be at most 120 characters");
const description = z.string().trim().max(1000, "Description must be at most 1000 characters");

interface StoredResult {
  index: number;
  type: string;
  status: string;
  message: string;
  output?: Record<string, unknown>;
  durationMs?: number;
  finishedAt?: string;
}

/** Bound what a run returns to the client (stored JSON is never trusted). */
function sanitizeResults(raw: unknown): StoredResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((r: Record<string, unknown>) => {
    const output: Record<string, string | number | boolean | null> = {};
    if (r.output && typeof r.output === "object") {
      for (const [k, v] of Object.entries(r.output as Record<string, unknown>).slice(0, 10)) {
        if (typeof v === "string") output[k.slice(0, 40)] = v.slice(0, 300);
        else if (typeof v === "number" || typeof v === "boolean" || v === null) output[k.slice(0, 40)] = v;
      }
    }
    return {
      index: typeof r.index === "number" ? r.index : 0,
      type: String(r.type ?? "UNKNOWN").slice(0, 40),
      status: String(r.status ?? "failed").slice(0, 20),
      message: String(r.message ?? "").slice(0, 300),
      output,
      durationMs: typeof r.durationMs === "number" ? r.durationMs : undefined,
      finishedAt: typeof r.finishedAt === "string" ? r.finishedAt.slice(0, 40) : undefined,
    };
  });
}

function triggerSummary(trigger: unknown) {
  const t = (trigger ?? {}) as { event?: unknown; conditions?: unknown };
  const event = normalizeTriggerEvent(t.event);
  return {
    event,
    label: event ? TRIGGER_EVENTS[event].label : "Unsupported trigger",
    conditionCount: Array.isArray(t.conditions) ? t.conditions.length : 0,
  };
}

function actionTypes(actions: unknown): string[] {
  return Array.isArray(actions)
    ? actions.slice(0, 20).map((a: { type?: unknown }) => (typeof a?.type === "string" ? a.type.slice(0, 40) : "UNKNOWN"))
    : [];
}

async function loadForWrite(ctx: Parameters<typeof requireProjectAccess>[0], workflowId: string) {
  const wf = found(
    await ctx.prisma.workflow.findUnique({ where: { id: workflowId }, select: { id: true, projectId: true, trigger: true, actions: true } }),
    "Workflow"
  );
  const project = await requireProjectAccess(ctx, wf.projectId, "workflows:manage");
  return { wf, project };
}

export const workflowRouter = router({
  /** Workflows across the active org's projects (optionally one project). */
  list: orgProcedure
    .input(
      z
        .object({
          orgId: id.optional(),
          projectId: id.optional(),
          limit: z.number().int().min(1).max(100).default(25),
          cursor: id.optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const orgId = ctx.org.orgId;
      const limit = input?.limit ?? 25;
      if (input?.projectId) {
        const project = await requireProjectAccess(ctx, input.projectId, "project:read");
        if (project.orgId !== orgId) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }
      const rows = await ctx.prisma.workflow.findMany({
        where: { project: { orgId }, ...(input?.projectId ? { projectId: input.projectId } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          name: true,
          description: true,
          enabled: true,
          trigger: true,
          actions: true,
          lastRunAt: true,
          runCount: true,
          createdAt: true,
          project: { select: { id: true, name: true } },
          runs: { take: 1, orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true } },
        },
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map((w) => ({
          id: w.id,
          name: w.name,
          description: w.description ? w.description.slice(0, 300) : null,
          enabled: w.enabled,
          trigger: triggerSummary(w.trigger),
          actionTypes: actionTypes(w.actions),
          lastRunAt: w.lastRunAt,
          lastRunStatus: w.runs[0]?.status ?? null,
          runCount: w.runCount,
          createdAt: w.createdAt,
          project: w.project,
        })),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        canManage: can(ctx.org.role, "workflows:manage"),
      };
    }),

  get: protectedProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const wf = found(
      await ctx.prisma.workflow.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          description: true,
          enabled: true,
          trigger: true,
          actions: true,
          projectId: true,
          lastRunAt: true,
          runCount: true,
          createdAt: true,
          updatedAt: true,
          project: { select: { id: true, name: true } },
        },
      }),
      "Workflow"
    );
    const access = await requireProjectAccess(ctx, wf.projectId, "project:read");
    const t = (wf.trigger ?? {}) as { event?: unknown; conditions?: unknown };
    const event = normalizeTriggerEvent(t.event);
    return {
      id: wf.id,
      name: wf.name,
      description: wf.description,
      enabled: wf.enabled,
      project: wf.project,
      trigger: { event, conditions: Array.isArray(t.conditions) ? (t.conditions as unknown[]).slice(0, 20) : [] },
      actions: Array.isArray(wf.actions) ? (wf.actions as unknown[]).slice(0, 20) : [],
      triggerLabel: event ? TRIGGER_EVENTS[event].label : "Unsupported trigger",
      lastRunAt: wf.lastRunAt,
      runCount: wf.runCount,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
      canManage: can(access.role, "workflows:manage"),
    };
  }),

  create: protectedProcedure
    .input(
      z.object({
        projectId: id,
        name,
        description: description.optional(),
        trigger: triggerSchema,
        actions: actionsSchema,
        enabled: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "workflows:manage");
      await assertCanCreate(project.orgId, "workflows");
      const def = await validateDefinition(ctx.prisma, { projectId: project.id, orgId: project.orgId }, input);
      const created = await ctx.prisma.workflow.create({
        data: {
          projectId: project.id,
          orgId: project.orgId,
          name: input.name,
          description: input.description || null,
          ...toJson(def),
          enabled: input.enabled,
          createdBy: ctx.user.id,
        },
        select: { id: true },
      });
      return created;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id,
        name: name.optional(),
        description: description.nullable().optional(),
        trigger: triggerSchema.optional(),
        actions: actionsSchema.optional(),
        enabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { wf, project } = await loadForWrite(ctx, input.id);
      const def = await validateDefinition(
        ctx.prisma,
        { projectId: project.id, orgId: project.orgId },
        { trigger: input.trigger ?? wf.trigger, actions: input.actions ?? wf.actions }
      );
      await ctx.prisma.workflow.update({
        where: { id: wf.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description || null } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...toJson(def),
        },
      });
      return { id: wf.id };
    }),

  delete: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const { wf } = await loadForWrite(ctx, input.id);
    await ctx.prisma.workflow.delete({ where: { id: wf.id } });
    return { id: wf.id };
  }),

  toggle: protectedProcedure.input(z.object({ id, enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const { wf, project } = await loadForWrite(ctx, input.id);
    if (input.enabled) {
      // Re-validate before enabling: a stored legacy definition must not start running unchecked.
      await validateDefinition(ctx.prisma, { projectId: project.id, orgId: project.orgId }, { trigger: wf.trigger, actions: wf.actions });
    }
    await ctx.prisma.workflow.update({ where: { id: wf.id }, data: { enabled: input.enabled } });
    return { id: wf.id, enabled: input.enabled };
  }),

  runs: protectedProcedure
    .input(z.object({ workflowId: id, limit: z.number().int().min(1).max(50).default(20), cursor: id.optional() }))
    .query(async ({ ctx, input }) => {
      const wf = found(await ctx.prisma.workflow.findUnique({ where: { id: input.workflowId }, select: { id: true, projectId: true } }), "Workflow");
      const project = await requireProjectAccess(ctx, wf.projectId, "project:read");
      const rows = await ctx.prisma.workflowRun.findMany({
        where: { workflowId: wf.id },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, status: true, eventId: true, causationDepth: true, error: true, startedAt: true, completedAt: true, actionsExecuted: true },
      });
      const page = rows.slice(0, input.limit);
      const eventIds = page.map((r) => r.eventId).filter((e): e is string => !!e);
      const events = eventIds.length
        ? await ctx.prisma.domainEvent.findMany({ where: { id: { in: eventIds }, orgId: project.orgId }, select: { id: true, type: true } })
        : [];
      const typeById = new Map(events.map((e) => [e.id, e.type]));
      return {
        items: page.map((r) => {
          const type = r.eventId ? normalizeTriggerEvent(typeById.get(r.eventId)) : null;
          return {
            id: r.id,
            status: r.status,
            trigger: r.eventId ? (type ? TRIGGER_EVENTS[type].label : "Event") : "Manual run",
            causationDepth: r.causationDepth,
            error: r.error ? r.error.slice(0, 2000) : null,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
            actions: sanitizeResults(r.actionsExecuted),
          };
        }),
        nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
      };
    }),

  /** Enqueue a manual run (tracked by a JobRun the client polls via job.get). */
  runManually: llmProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const { wf, project } = await loadForWrite(ctx, input.id);
    const job = await ctx.prisma.jobRun.create({
      data: {
        kind: "WORKFLOW_MANUAL_RUN",
        orgId: project.orgId,
        projectId: project.id,
        createdById: ctx.user.id,
        status: "PENDING",
        input: { workflowId: wf.id },
      },
      select: { id: true },
    });
    await enqueue(QUEUE.WORKFLOWS, { workflowId: wf.id, eventId: null, jobRunId: job.id }, { jobId: `wfm_${job.id}` });
    return { jobRunId: job.id };
  }),

  listTemplates: protectedProcedure.query(() =>
    WORKFLOW_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      triggerLabel: TRIGGER_EVENTS[t.trigger.event].label,
      conditionCount: t.trigger.conditions.length,
      actions: t.actions.map((a) => ({ type: a.type, label: ACTION_META[a.type].label, requires: ACTION_META[a.type].requires ?? null })),
    }))
  ),

  /** Install a template into a project. Installed disabled so it is reviewed first. */
  installTemplate: protectedProcedure
    .input(z.object({ templateId: z.string().min(1).max(100), projectId: id, name: name.optional() }))
    .mutation(async ({ ctx, input }) => {
      const template = getWorkflowTemplate(input.templateId);
      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
      const project = await requireProjectAccess(ctx, input.projectId, "workflows:manage");
      await assertCanCreate(project.orgId, "workflows");
      const def = await validateDefinition(ctx.prisma, { projectId: project.id, orgId: project.orgId }, template);
      return ctx.prisma.workflow.create({
        data: {
          projectId: project.id,
          orgId: project.orgId,
          name: input.name ?? template.name,
          description: template.description,
          ...toJson(def),
          enabled: false,
          createdBy: ctx.user.id,
        },
        select: { id: true },
      });
    }),

  /** Choices for the builder's member/roadmap/recommendation pickers (project-scoped). */
  formOptions: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const [members, roadmaps, recommendations, integrations] = await Promise.all([
      ctx.prisma.orgMember.findMany({
        where: { orgId: project.orgId, joinedAt: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 200,
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
      }),
      ctx.prisma.roadmap.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true } }),
      ctx.prisma.recommendation.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, title: true } }),
      ctx.prisma.integration.findMany({
        where: { orgId: project.orgId, provider: { in: ["SLACK", "JIRA", "LINEAR"] } },
        select: { provider: true, status: true },
      }),
    ]);
    return {
      members: members.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role })),
      roadmaps,
      recommendations: recommendations.map((r) => ({ id: r.id, title: r.title.slice(0, 200) })),
      connected: {
        SLACK: integrations.some((i) => i.provider === "SLACK" && i.status === "CONNECTED"),
        JIRA: integrations.some((i) => i.provider === "JIRA" && i.status === "CONNECTED"),
        LINEAR: integrations.some((i) => i.provider === "LINEAR" && i.status === "CONNECTED"),
      },
    };
  }),
});
