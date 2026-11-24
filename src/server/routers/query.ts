/**
 * Ask questions about a project's research (hybrid RAG with verified
 * citations) and read the caller's question history for that project.
 */
import { z } from "zod";
import { router, protectedProcedure, llmProcedure } from "../trpc";
import { requireProjectAccess } from "../auth/access";
import { askProject, parseStoredCitations } from "../ai/rag";

const id = z.string().min(1).max(64);

export const queryRouter = router({
  ask: llmProcedure
    .input(z.object({ projectId: id, question: z.string().trim().min(3, "Ask a longer question").max(2_000, "Question is too long") }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "ai:run");
      return askProject({ projectId: project.id, orgId: project.orgId, userId: ctx.user.id, question: input.question });
    }),

  /**
   * The caller's questions in this project, newest page first; items within a
   * page are in chronological order. `nextCursor` loads the next older page.
   */
  history: protectedProcedure
    .input(z.object({ projectId: id, limit: z.number().int().min(1).max(50).default(20), cursor: id.nullish() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProjectAccess(ctx, input.projectId, "project:read");
      const rows = await ctx.prisma.query.findMany({
        where: { projectId: project.id, userId: ctx.user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: { id: true, question: true, answer: true, citations: true, createdAt: true },
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page
          .map((q) => {
            const { citations, insufficientEvidence } = parseStoredCitations(q.citations);
            return { id: q.id, question: q.question, answer: q.answer, citations, insufficientEvidence, createdAt: q.createdAt };
          })
          .reverse(),
        nextCursor: rows.length > input.limit ? page[page.length - 1].id : null,
      };
    }),
});
