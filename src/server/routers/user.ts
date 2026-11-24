/**
 * The signed-in user's own profile, notification preferences, data export and
 * account deletion.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router, protectedProcedure, rateLimited } from "../trpc";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { getIdentityProvider } from "../team/identity";
import { effectivePrefs, mergePrefs, notificationPrefsSchema } from "../team/preferences";
import { deleteAccount, exportUserData, orgsBlockingDeletion } from "../team/account";

const EXPORT_RATE = { name: "user-export", limit: 5, windowMs: 60 * 60_000 } as const;

export const userRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUnique({
      where: { id: ctx.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        notificationPrefs: true,
        createdAt: true,
        orgMembers: {
          where: { joinedAt: { not: null } },
          select: {
            role: true,
            joinedAt: true,
            organization: { select: { id: true, name: true, slug: true, isPersonal: true, plan: true } },
          },
          take: 500,
        },
      },
    });
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
      notificationPrefs: effectivePrefs(user.notificationPrefs),
      memberships: user.orgMembers
        .map((m) => ({
          orgId: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          isPersonal: m.organization.isPersonal,
          plan: m.organization.plan,
          role: m.role,
          joinedAt: m.joinedAt,
        }))
        .sort((a, b) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name)),
    };
  }),

  update: protectedProcedure
    .use(rateLimited(RATE_LIMITS.write))
    .input(
      z
        .object({
          name: z.string().trim().min(1, "Name is required").max(100, "Names can be at most 100 characters").optional(),
          notificationPrefs: notificationPrefsSchema.optional(),
        })
        .strict()
        .refine((v) => v.name !== undefined || v.notificationPrefs !== undefined, "Nothing to update")
    )
    .mutation(async ({ ctx, input }) => {
      const data: Prisma.UserUpdateInput = {};
      if (input.name !== undefined) {
        const name = input.name.replace(/\s+/g, " ");
        // Keep the identity provider in sync, or its next user.updated webhook would revert the change.
        try {
          await getIdentityProvider().updateName(ctx.user.clerkId, name);
        } catch (err) {
          logger.error("identity provider name update failed", { userId: ctx.user.id, err });
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "We couldn't update your name. Please try again." });
        }
        data.name = name;
      }
      if (input.notificationPrefs) {
        const current = await ctx.prisma.user.findUnique({ where: { id: ctx.user.id }, select: { notificationPrefs: true } });
        data.notificationPrefs = mergePrefs(current?.notificationPrefs, input.notificationPrefs) as Prisma.InputJsonValue;
      }
      const user = await ctx.prisma.user.update({
        where: { id: ctx.user.id },
        data,
        select: { id: true, name: true, notificationPrefs: true },
      });
      return { id: user.id, name: user.name, notificationPrefs: effectivePrefs(user.notificationPrefs) };
    }),

  /** Organizations that must get another owner before the account can be deleted. */
  deletionBlockers: protectedProcedure.query(async ({ ctx }) => {
    return orgsBlockingDeletion(ctx.user.id);
  }),

  /** Delete the account and all personal data. The caller must type DELETE. */
  deleteAccount: protectedProcedure
    .input(z.object({ confirm: z.literal("DELETE", { message: 'Type "DELETE" to confirm' }) }))
    .mutation(async ({ ctx }) => {
      const res = await deleteAccount({ id: ctx.user.id, clerkId: ctx.user.clerkId });
      logger.info("account deleted", { userId: ctx.user.id, deletedProjects: res.deletedProjects });
      return { deleted: true as const };
    }),

  /** JSON export of the user's own data (GDPR). Bounded; see `truncated` in the result. */
  exportData: protectedProcedure.use(rateLimited(EXPORT_RATE)).mutation(async ({ ctx }) => {
    return exportUserData(ctx.user.id);
  }),
});
