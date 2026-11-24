import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createDocumentFromText } from "@/server/documents/ingest";
import { documentWorker } from "@/workers/document-worker";
import { retrieveChunks } from "@/server/ai/rag/retriever";
import { FEATURES } from "@/server/ai/prompts";
import { llmCalls, scriptLLM } from "../helpers/doubles";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { callerFor, chunksInPrompt, runWorker } from "./helpers";

async function ingest(projectId: string, title: string, text: string) {
  const { documentId } = await createDocumentFromText({ projectId, title, type: "TRANSCRIPT", source: "QUICK_CAPTURE", text });
  await runWorker(documentWorker, { documentId });
  return prisma.chunk.findFirstOrThrow({ where: { documentId } });
}

describe("RAG", () => {
  it("retrieves only the authorized project's chunks (vector and keyword arms)", async () => {
    const user = await createUser();
    const a = await createProject(user, undefined, "A");
    const b = await createProject(user, undefined, "B");
    const chunkA = await ingest(a.id, "Interview A", "The CSV export times out on large workspaces every Monday morning.");
    const chunkB = await ingest(b.id, "Interview B", "The CSV export times out on large workspaces for project B as well.");

    const results = await retrieveChunks({ projectId: a.id, orgId: user.personalOrgId, question: "Why does the CSV export time out?" });
    expect(results.map((r) => r.chunkId)).toEqual([chunkA.id]);
    expect(results[0].similarity).not.toBeNull();
    expect(results[0].keywordRank).not.toBeNull();
    expect(results.some((r) => r.chunkId === chunkB.id)).toBe(false);
  });

  it("answers with verified citations, dropping fabricated chunk ids and quotes", async () => {
    const user = await createUser();
    const a = await createProject(user, undefined, "A");
    const b = await createProject(user, undefined, "B");
    const chunkA = await ingest(a.id, "Interview A", "Dana: The CSV export times out on large workspaces every Monday. It costs me the whole morning.");
    const chunkB = await ingest(b.id, "Interview B", "Other customer: The CSV export is fine for us.");

    scriptLLM(FEATURES.queryAnswer, (req) => {
      const shown = chunksInPrompt(req.prompt);
      expect(shown.map((c) => c.id)).toEqual([chunkA.id]);
      expect(req.prompt).not.toContain(chunkB.content);
      expect(req.system).toContain("untrusted_data");
      return {
        answer: "Customers report that the CSV export times out on large workspaces, which costs them time every week.",
        citations: [
          { chunkId: chunkA.id, quote: "the csv export times out on LARGE workspaces every Monday" },
          { chunkId: chunkB.id, quote: "The CSV export is fine for us." },
          { chunkId: chunkA.id, quote: "The export works perfectly and quickly." },
          { chunkId: "fabricated-id", quote: "It costs me the whole morning." },
        ],
        insufficientEvidence: false,
      };
    });

    const res = await callerFor(user).query.ask({ projectId: a.id, question: "What do customers say about the CSV export?" });
    expect(res.insufficientEvidence).toBe(false);
    expect(res.citations).toEqual([
      {
        chunkId: chunkA.id,
        documentId: chunkA.documentId,
        documentTitle: "Interview A",
        quote: "The CSV export times out on large workspaces every Monday",
        position: 0,
      },
    ]);
    const row = await prisma.query.findUniqueOrThrow({ where: { id: res.id } });
    expect(row.citations).toMatchObject({ dropped: 3, retrieved: 1, items: [{ chunkId: chunkA.id }] });
    expect(llmCalls.filter((c) => c.feature === FEATURES.queryAnswer)).toHaveLength(1);
  });

  it("treats an answer with no verifiable citation as insufficient evidence", async () => {
    const user = await createUser();
    const a = await createProject(user);
    await ingest(a.id, "Notes", "Billing page loads slowly for enterprise accounts.");
    scriptLLM(FEATURES.queryAnswer, () => ({ answer: "Something unsupported.", citations: [{ chunkId: "nope", quote: "made up quote text" }], insufficientEvidence: false }));
    const res = await callerFor(user).query.ask({ projectId: a.id, question: "What about billing?" });
    expect(res.citations).toEqual([]);
    expect(res.insufficientEvidence).toBe(true);
  });

  it("does not call the model when the project has no content", async () => {
    const user = await createUser();
    const a = await createProject(user);
    const res = await callerFor(user).query.ask({ projectId: a.id, question: "Anything about onboarding?" });
    expect(res.insufficientEvidence).toBe(true);
    expect(res.citations).toEqual([]);
    expect(llmCalls).toHaveLength(0);
  });

  it("returns the caller's history in chronological order, paginating backwards", async () => {
    const user = await createUser();
    const colleague = await createUser();
    const org = await createOrg(user);
    await addMember(org.id, colleague, "MEMBER");
    const a = await createProject(user, org.id);
    const caller = callerFor(user);
    for (const q of ["first question?", "second question?", "third question?"]) {
      await caller.query.ask({ projectId: a.id, question: q });
      await new Promise((r) => setTimeout(r, 5));
    }
    await callerFor(colleague).query.ask({ projectId: a.id, question: "colleague question?" });

    const latest = await caller.query.history({ projectId: a.id, limit: 2 });
    expect(latest.items.map((q) => q.question)).toEqual(["second question?", "third question?"]);
    expect(latest.nextCursor).not.toBeNull();
    const older = await caller.query.history({ projectId: a.id, limit: 2, cursor: latest.nextCursor });
    expect(older.items.map((q) => q.question)).toEqual(["first question?"]);
    expect(older.nextCursor).toBeNull();
  });

  it("validates question length", async () => {
    const user = await createUser();
    const a = await createProject(user);
    await expect(callerFor(user).query.ask({ projectId: a.id, question: "x".repeat(2_001) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
