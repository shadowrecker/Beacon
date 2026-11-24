/**
 * Team views for the active organization (orgProcedure: `x-org-id` header or
 * input.orgId, membership verified). All data is the org's own.
 */
import { z } from "zod";
import { router, orgProcedure } from "../trpc";
import { found } from "../auth/access";
import { getActivityFeed } from "../team/activity";
import { getCrossProjectThemes, getTeamDashboard } from "../team/dashboard";

const id = z.string().min(1).max(64);

export const teamRouter = router({
  dashboard: orgProcedure.input(z.object({ orgId: id.optional() }).optional()).query(async ({ ctx }) => {
    return getTeamDashboard(ctx.prisma, ctx.org.orgId);
  }),

  activityFeed: orgProcedure
    .input(
      z.object({
        orgId: id.optional(),
        projectId: id.optional(),
        userId: id.optional(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Filters must refer to this org's own projects and members.
      if (input.projectId) {
        found(await ctx.prisma.project.findFirst({ where: { id: input.projectId, orgId: ctx.org.orgId }, select: { id: true } }), "Project");
      }
      if (input.userId) {
        found(
          await ctx.prisma.orgMember.findFirst({ where: { orgId: ctx.org.orgId, userId: input.userId }, select: { id: true } }),
          "Member"
        );
      }
      return getActivityFeed(ctx.prisma, {
        orgId: ctx.org.orgId,
        projectId: input.projectId,
        userId: input.userId,
        limit: input.limit,
        cursor: input.cursor,
      });
    }),

  /** Themes from each project's latest READY synthesis, grouped by name across projects. */
  crossProjectThemes: orgProcedure
    .input(
      z.object({
        orgId: id.optional(),
        minProjects: z.number().int().min(1).max(50).default(2),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().regex(/^\d{1,6}$/).nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      return getCrossProjectThemes(ctx.prisma, ctx.org.orgId, {
        minProjects: input.minProjects,
        limit: input.limit,
        cursor: input.cursor,
      });
    }),
});
