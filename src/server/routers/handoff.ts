/**
 * Engineering handoff: export a recommendation to Markdown, Jira or Linear.
 *
 * - The recommendation is looked up scoped to the authorized project.
 * - MARKDOWN returns the document inline (generating the brief if missing).
 * - JIRA/LINEAR create a JobRun(kind HANDOFF_EXPORT) and enqueue QUEUE.HANDOFF;
 *   the worker pushes through the project's own org integration. Clients poll
 *   job.get({ id }). The org, credentials and destination are never taken from
 *   the request.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router, protectedProcedure, llmProcedure } from "../trpc";
import { found, requireProjectAccess } from "../auth/access";
import { enqueue, QUEUE } from "../jobs/queues";
import { HANDOFF_TARGETS, handoffRunInputSchema, handoffRunOutputSchema, prepareHandoff } from "../ai/handoff/exporter";
import { NonRetryableError } from "../jobs/worker";

const id = z.string().min(1).max(64);

export const handoffRouter = router({
  /** Which export targets are available for this project's org. */
  targets: protectedProcedure.input(z.object({ projectId: id })).query(async ({ ctx, input }) => {
    const project = await requireProjectAccess(ctx, input.projectId, "project:read");
    const rows = await ctx.prisma.integration.findMany({
      where: { orgId: project.orgId, provider: { in: ["JIRA", "LINEAR"] }, status: "CONNECTED" },
      select: { provider: true },
    });
    const connected = new Set(rows.map((r) => r.provider));
    return { markdown: true, jira: connected.has("JIRA"), linear: connected.has("LINEAR") };
  }),

  export: llmProcedure
    .input(
      z.object({
        projectId: id,
        recommendationId: id,
        target: z.enum(HANDOFF_TARGETS),
        jiraProjectKey: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z][A-Z0-9_]{1,9}$/, "Enter a Jira project key such as PROD")
          .optional(),
        linearTeamId: z.string().trim().regex(/^[a-zA-Z0-9-]{1,64}$/, "Enter a valid Linear team ID").optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "data:export");
      const rec = found(
        await ctx.prisma.recommendation.findFirst({
          where: { id: input.recommendationId, projectId: project.id },
          select: { id: true },
        }),
        "Recommendation"
      );

      if (input.target === "MARKDOWN") {
        try {
          const doc = await prepareHandoff({ recommendationId: rec.id, projectId: project.id, orgId: project.orgId });
          return { target: "MARKDOWN" as const, title: doc.title, filename: doc.filename, content: doc.markdown, quoteCount: doc.quoteCount };
        } catch (err) {
          if (err instanceof NonRetryableError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
          throw err;
        }
      }

      const provider = input.target;
      const integration = await ctx.prisma.integration.findFirst({
        where: { orgId: project.orgId, provider, status: "CONNECTED" },
        select: { id: true },
      });
      if (!integration) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${provider === "JIRA" ? "Jira" : "Linear"} is not connected for this workspace`,
        });
      }

      // One export per recommendation and target at a time (double-click safe).
      const inFlight = await ctx.prisma.jobRun.findFirst({
        where: {
          projectId: project.id,
          kind: "HANDOFF_EXPORT",
          status: { in: ["PENDING", "PROCESSING"] },
          AND: [
            { input: { path: ["recommendationId"], equals: rec.id } },
            { input: { path: ["target"], equals: provider } },
          ],
        },
        select: { id: true, status: true },
      });
      if (inFlight) return { target: provider, jobRunId: inFlight.id, status: inFlight.status, alreadyRunning: true };

      const runInput = handoffRunInputSchema.parse({
        recommendationId: rec.id,
        target: provider,
        ...(provider === "JIRA" && input.jiraProjectKey ? { jiraProjectKey: input.jiraProjectKey } : {}),
        ...(provider === "LINEAR" && input.linearTeamId ? { linearTeamId: input.linearTeamId } : {}),
      });
      const run = await ctx.prisma.jobRun.create({
        data: {
          kind: "HANDOFF_EXPORT",
          orgId: project.orgId,
          projectId: project.id,
          createdById: ctx.user.id,
          status: "PENDING",
          input: runInput as unknown as Prisma.InputJsonValue,
        },
        select: { id: true, status: true },
      });
      await enqueue(QUEUE.HANDOFF, { jobRunId: run.id }, { jobId: `handoff_${run.id}` });
      return { target: provider, jobRunId: run.id, status: run.status, alreadyRunning: false };
    }),

  /** Recent Jira/Linear exports of a recommendation (issue links). */
  history: protectedProcedure
    .input(z.object({ projectId: id, recommendationId: id, limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const runs = await ctx.prisma.jobRun.findMany({
        where: { projectId: project.id, kind: "HANDOFF_EXPORT", input: { path: ["recommendationId"], equals: input.recommendationId } },
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: { id: true, status: true, input: true, output: true, errorMessage: true, createdAt: true, completedAt: true },
      });
      return runs.map((r) => {
        const inp = handoffRunInputSchema.safeParse(r.input);
        const out = handoffRunOutputSchema.safeParse(r.output);
        return {
          id: r.id,
          status: r.status,
          target: inp.success ? inp.data.target : null,
          issueKey: out.success ? out.data.issueKey : null,
          url: out.success && /^https:\/\//.test(out.data.url) ? out.data.url : null,
          errorMessage: r.errorMessage,
          createdAt: r.createdAt,
          completedAt: r.completedAt,
        };
      });
    }),
});
