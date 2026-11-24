/**
 * Collaboration: comments (threaded, with @mentions) and the caller's
 * notifications.
 *
 * Comments live inside a project: every procedure authorizes the project first
 * and then looks up the target and comment IDs scoped to that project, so IDs
 * from another project or org are NOT_FOUND. Mentions resolve only to joined
 * members of the project's organization.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { CommentTargetType, Prisma } from "@prisma/client";
import { router, protectedProcedure, rateLimited } from "../trpc";
import { can, found, requireProjectAccess } from "../auth/access";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { emitEvent } from "../events/bus";
import { notify } from "../notifications/notify";
import { findCommentTarget } from "../collaboration/targets";
import { MentionError, mentionsToPlainText, resolveMentions, tokenUserIds } from "../collaboration/mentions";
import { commentTargetPath, linkFor, RESOURCE, resolveResourceLinks, TARGET_LABELS } from "../collaboration/links";
import { displayName, truncate } from "../team/format";
import type { DbClient } from "@/lib/db";

const id = z.string().min(1).max(64);
const content = z
  .string()
  .trim()
  .min(1, "Write something first")
  .max(5000, "Comments can be at most 5,000 characters");
const targetType = z.enum(CommentTargetType);

const MAX_REPLIES_PER_THREAD = 200;

const authorSelect = { id: true, name: true, email: true, avatarUrl: true } as const;
const commentSelect = {
  id: true,
  userId: true,
  content: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
  user: { select: authorSelect },
} satisfies Prisma.CommentSelect;

type CommentRow = Prisma.CommentGetPayload<{ select: typeof commentSelect }>;

function mentionErrorToTRPC(err: unknown): never {
  if (err instanceof MentionError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  throw err;
}

/** Current display names of mentioned users who are members of the org. */
async function mentionNames(db: DbClient, orgId: string, contents: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(contents.flatMap((c) => tokenUserIds(c)))];
  if (ids.length === 0) return new Map();
  const members = await db.orgMember.findMany({
    where: { orgId, userId: { in: ids }, joinedAt: { not: null } },
    select: { user: { select: { id: true, name: true, email: true } } },
  });
  return new Map(members.map((m) => [m.user.id, displayName(m.user)]));
}

export const collaborationRouter = router({
  /** Org members of the project's organization, for the @mention picker. */
  mentionCandidates: protectedProcedure
    .input(z.object({ projectId: id, query: z.string().trim().max(100).optional(), limit: z.number().int().min(1).max(20).default(8) }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const q = input.query?.replace(/^@/, "");
      const members = await ctx.prisma.orgMember.findMany({
        where: {
          orgId: project.orgId,
          joinedAt: { not: null },
          ...(q
            ? {
                user: {
                  OR: [
                    { name: { contains: q, mode: "insensitive" as const } },
                    { email: { startsWith: q, mode: "insensitive" as const } },
                  ],
                },
              }
            : {}),
        },
        select: { user: { select: authorSelect } },
        orderBy: { joinedAt: "asc" },
        take: input.limit,
      });
      return members.map((m) => ({
        id: m.user.id,
        name: displayName(m.user),
        handle: m.user.email?.split("@")[0] ?? null,
        avatarUrl: m.user.avatarUrl,
      }));
    }),

  addComment: protectedProcedure
    .use(rateLimited(RATE_LIMITS.write))
    .input(
      z.object({
        projectId: id,
        targetType,
        targetId: id,
        content,
        parentId: id.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:write");
      found(await findCommentTarget(ctx.prisma, project.id, input.targetType, input.targetId), "Comment target");

      // Replies are one level deep: a reply to a reply joins the root thread.
      let parentId: string | null = null;
      if (input.parentId) {
        const parent = found(
          await ctx.prisma.comment.findFirst({
            where: { id: input.parentId, projectId: project.id, targetType: input.targetType, targetId: input.targetId },
            select: { id: true, parentId: true },
          }),
          "Comment"
        );
        parentId = parent.parentId ?? parent.id;
      }

      const mentionedUserIds = await resolveMentions(ctx.prisma, project.orgId, input.content).catch(mentionErrorToTRPC);

      const comment = await ctx.prisma.comment.create({
        data: {
          userId: ctx.user.id,
          projectId: project.id,
          targetType: input.targetType,
          targetId: input.targetId,
          content: input.content,
          parentId,
        },
        select: { id: true, parentId: true, createdAt: true },
      });

      await emitEvent({
        orgId: project.orgId,
        projectId: project.id,
        type: "comment.created",
        payload: {
          commentId: comment.id,
          targetType: input.targetType,
          targetId: input.targetId,
          mentionedUserIds: mentionedUserIds.filter((u) => u !== ctx.user.id),
        },
        actorUserId: ctx.user.id,
      });

      return { id: comment.id, parentId: comment.parentId, createdAt: comment.createdAt, mentionedUserIds };
    }),

  /** Threads on a target: top-level comments paginated oldest-first, each with its replies. */
  getComments: protectedProcedure
    .input(
      z.object({
        projectId: id,
        targetType,
        targetId: id,
        limit: z.number().int().min(1).max(50).default(20),
        cursor: id.nullish(),
      })
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      found(await findCommentTarget(ctx.prisma, project.id, input.targetType, input.targetId), "Comment target");

      const where = { projectId: project.id, targetType: input.targetType, targetId: input.targetId };
      const roots = await ctx.prisma.comment.findMany({
        where: { ...where, parentId: null },
        select: { ...commentSelect, _count: { select: { replies: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = roots.length > input.limit;
      const page = hasMore ? roots.slice(0, input.limit) : roots;

      const replies = page.length
        ? await ctx.prisma.comment.findMany({
            where: { ...where, parentId: { in: page.map((r) => r.id) } },
            select: commentSelect,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: page.length * MAX_REPLIES_PER_THREAD,
          })
        : [];
      const byParent = new Map<string, CommentRow[]>();
      for (const r of replies) {
        const list = byParent.get(r.parentId as string) ?? [];
        if (list.length < MAX_REPLIES_PER_THREAD) list.push(r);
        byParent.set(r.parentId as string, list);
      }

      const names = await mentionNames(ctx.prisma, project.orgId, [...page, ...replies].map((c) => c.content));
      const isAdmin = can(project.role, "members:manage");
      const canComment = can(project.role, "project:write");
      const shape = (c: CommentRow) => ({
        id: c.id,
        content: c.content,
        parentId: c.parentId,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        edited: c.updatedAt.getTime() - c.createdAt.getTime() > 1000,
        author: { id: c.user.id, name: displayName(c.user), avatarUrl: c.user.avatarUrl },
        mentions: tokenUserIds(c.content)
          .filter((u) => names.has(u))
          .map((u) => ({ id: u, name: names.get(u) as string })),
        canEdit: c.userId === ctx.user.id && canComment,
        canDelete: c.userId === ctx.user.id || isAdmin,
      });

      return {
        items: page.map((r) => ({
          ...shape(r),
          replyCount: r._count.replies,
          replies: (byParent.get(r.id) ?? []).map(shape),
        })),
        nextCursor: hasMore ? page[page.length - 1].id : null,
        canComment,
      };
    }),

  /** Authors edit their own comments; people newly mentioned are notified. */
  editComment: protectedProcedure
    .use(rateLimited(RATE_LIMITS.write))
    .input(z.object({ projectId: id, commentId: id, content }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const comment = found(
        await ctx.prisma.comment.findFirst({
          where: { id: input.commentId, projectId: project.id },
          select: { id: true, userId: true, content: true, targetType: true, targetId: true },
        }),
        "Comment"
      );
      if (comment.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only edit your own comments" });
      }
      if (!can(project.role, "project:write")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to do this" });
      }

      const before = new Set(await resolveMentions(ctx.prisma, project.orgId, comment.content).catch(() => [] as string[]));
      const after = await resolveMentions(ctx.prisma, project.orgId, input.content).catch(mentionErrorToTRPC);
      const updated = await ctx.prisma.comment.update({
        where: { id: comment.id },
        data: { content: input.content },
        select: { id: true, updatedAt: true },
      });

      const added = after.filter((u) => !before.has(u) && u !== ctx.user.id);
      if (added.length > 0) {
        const names = await mentionNames(ctx.prisma, project.orgId, [input.content]);
        const author = await ctx.prisma.user.findUnique({ where: { id: ctx.user.id }, select: { name: true, email: true } });
        const target = await findCommentTarget(ctx.prisma, project.id, comment.targetType, comment.targetId);
        await notify({
          userIds: added,
          type: "COMMENT_MENTION",
          title: `${displayName(author)} mentioned you`,
          message: `${truncate(mentionsToPlainText(input.content, names), 280)}\n\nOn the ${TARGET_LABELS[comment.targetType]} "${target?.label ?? "item"}" in ${project.name}.`,
          resourceType: RESOURCE.COMMENT,
          resourceId: comment.id,
          href: commentTargetPath(project.id, comment.targetType),
          dedupeKey: `comment-edit:${comment.id}:${updated.updatedAt.getTime()}`,
        });
      }
      return { id: updated.id, updatedAt: updated.updatedAt };
    }),

  /** Authors delete their own comments; admins and owners can delete any. Replies go with it. */
  deleteComment: protectedProcedure
    .input(z.object({ projectId: id, commentId: id }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const comment = found(
        await ctx.prisma.comment.findFirst({ where: { id: input.commentId, projectId: project.id }, select: { id: true, userId: true } }),
        "Comment"
      );
      if (comment.userId !== ctx.user.id && !can(project.role, "members:manage")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You can only delete your own comments" });
      }
      await ctx.prisma.comment.delete({ where: { id: comment.id } });
      return { id: comment.id };
    }),

  getNotifications: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(20),
          cursor: id.nullish(),
          unreadOnly: z.boolean().default(false),
        })
        .default({ limit: 20, unreadOnly: false })
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.prisma.notification.findMany({
        where: { userId: ctx.user.id, ...(input.unreadOnly ? { isRead: false } : {}) },
        select: { id: true, type: true, title: true, message: true, isRead: true, resourceType: true, resourceId: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const links = await resolveResourceLinks(ctx.prisma, page);
      return {
        items: page.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          message: n.message,
          isRead: n.isRead,
          createdAt: n.createdAt,
          href: linkFor(links, n),
        })),
        nextCursor: hasMore ? page[page.length - 1].id : null,
      };
    }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const count = await ctx.prisma.notification.count({ where: { userId: ctx.user.id, isRead: false } });
    return { count };
  }),

  markRead: protectedProcedure
    .input(z.object({ ids: z.array(id).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const res = await ctx.prisma.notification.updateMany({
        where: { id: { in: input.ids }, userId: ctx.user.id, isRead: false },
        data: { isRead: true },
      });
      return { updated: res.count };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    const res = await ctx.prisma.notification.updateMany({
      where: { userId: ctx.user.id, isRead: false },
      data: { isRead: true },
    });
    return { updated: res.count };
  }),
});
