/**
 * Generic job status for polling (JobRun rows). Scoped to projects the caller
 * can read; org-level runs (no project) require org membership.
 */
import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { found, requireOrgPermission, requireProjectAccess } from "../auth/access";

export const jobRouter = router({
  get: protectedProcedure.input(z.object({ id: z.string().min(1) })).query(async ({ ctx, input }) => {
    const run = found(
      await ctx.prisma.jobRun.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          kind: true,
          orgId: true,
          projectId: true,
          status: true,
          output: true,
          errorMessage: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
        },
      }),
      "Job"
    );
    if (run.projectId) await requireProjectAccess(ctx, run.projectId, "project:read");
    else await requireOrgPermission(ctx, run.orgId, "org:read");
    return run;
  }),
});
