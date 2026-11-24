/**
 * Projects: org-scoped containers for documents, syntheses and recommendations.
 *
 * list follows the cross-feature contract in docs/ENGINEERING.md.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getStorage, projectPrefix } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { router, orgProcedure, protectedProcedure } from "../trpc";
import { can, requireProjectAccess } from "../auth/access";
import { assertCanCreate } from "../usage/entitlements";

const id = z.string().min(1).max(64);
const name = z.string().trim().min(1, "Project name is required").max(120, "Project name is too long");
const description = z.string().trim().max(2_000, "Description is too long");

const countsSelect = { _count: { select: { documents: true, syntheses: true, recommendations: true } } } as const;

export const projectRouter = router({
  list: orgProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).optional(),
          cursor: id.nullish(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 20;
      const rows = await ctx.prisma.project.findMany({
        where: { orgId: ctx.org.orgId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(input?.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, name: true, description: true, createdAt: true, updatedAt: true, ...countsSelect },
      });
      const page = rows.slice(0, limit);
      return {
        items: page.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          counts: { documents: p._count.documents, syntheses: p._count.syntheses, recommendations: p._count.recommendations },
        })),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      };
    }),

  getById: protectedProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const access = await requireProjectAccess(ctx, input.id, "project:read");
    const [project, readyDocuments, processingDocuments, failedDocuments, documents, syntheses, recommendations, latestReadySynthesis] = await Promise.all([
      ctx.prisma.project.findUniqueOrThrow({
        where: { id: access.id },
        select: { id: true, name: true, description: true, orgId: true, createdAt: true, updatedAt: true, ...countsSelect },
      }),
      ctx.prisma.document.count({ where: { projectId: access.id, status: "READY" } }),
      ctx.prisma.document.count({ where: { projectId: access.id, status: { in: ["PENDING", "PROCESSING"] } } }),
      ctx.prisma.document.count({ where: { projectId: access.id, status: "FAILED" } }),
      ctx.prisma.document.findMany({
        where: { projectId: access.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, title: true, type: true, status: true, createdAt: true },
      }),
      ctx.prisma.synthesis.findMany({
        where: { projectId: access.id },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { id: true, type: true, status: true, createdAt: true, completedAt: true, _count: { select: { themes: true } } },
      }),
      ctx.prisma.recommendation.findMany({
        where: { projectId: access.id },
        orderBy: [{ createdAt: "desc" }, { confidence: "desc" }],
        take: 5,
        select: { id: true, title: true, impact: true, confidence: true, status: true, createdAt: true },
      }),
      ctx.prisma.synthesis.findFirst({
        where: { projectId: access.id, status: "READY" },
        orderBy: { completedAt: "desc" },
        select: { id: true, type: true, completedAt: true, _count: { select: { themes: true } } },
      }),
    ]);
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      orgId: project.orgId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      role: access.role,
      permissions: {
        write: can(access.role, "project:write"),
        runAI: can(access.role, "ai:run"),
        delete: can(access.role, "project:delete"),
      },
      counts: {
        documents: project._count.documents,
        readyDocuments,
        processingDocuments,
        failedDocuments,
        syntheses: project._count.syntheses,
        recommendations: project._count.recommendations,
      },
      recent: {
        documents,
        syntheses: syntheses.map(({ _count, ...s }) => ({ ...s, themeCount: _count.themes })),
        recommendations,
      },
      latestReadySynthesis: latestReadySynthesis
        ? {
            id: latestReadySynthesis.id,
            type: latestReadySynthesis.type,
            completedAt: latestReadySynthesis.completedAt,
            themeCount: latestReadySynthesis._count.themes,
          }
        : null,
    };
  }),

  create: orgProcedure
    .input(z.object({ name, description: description.optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.org.role, "project:create")) {
        throw new TRPCError({ code: "FORBIDDEN", message: "You do not have permission to create projects in this workspace" });
      }
      await assertCanCreate(ctx.org.orgId, "projects");
      const project = await ctx.prisma.project.create({
        data: { name: input.name, description: input.description || null, orgId: ctx.org.orgId, userId: ctx.user.id },
        select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
      });
      return project;
    }),

  update: protectedProcedure
    .input(z.object({ id, name: name.optional(), description: description.nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireProjectAccess(ctx, input.id, "project:write");
      return ctx.prisma.project.update({
        where: { id: access.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description || null } : {}),
        },
        select: { id: true, name: true, description: true, updatedAt: true },
      });
    }),

  delete: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const access = await requireProjectAccess(ctx, input.id, "project:delete");
    // Rows (documents, chunks and their vectors, syntheses, ...) cascade in the DB.
    await ctx.prisma.project.delete({ where: { id: access.id } });
    let objectsDeleted = 0;
    try {
      objectsDeleted = await getStorage().deletePrefix(projectPrefix(access.id));
    } catch (err) {
      logger.error("failed to purge project storage", { projectId: access.id, err });
    }
    return { success: true as const, objectsDeleted };
  }),
});
