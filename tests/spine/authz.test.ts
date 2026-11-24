/**
 * Authorization matrix for the data-spine procedures: outsiders get NOT_FOUND,
 * VIEWERs can read but not write or run AI, and IDs from another project (or
 * org) paired with an authorized project are rejected as NOT_FOUND.
 */
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { addMember, createOrg, createProject, createUser, type TestUser } from "../helpers/factories";
import { callerFor } from "./helpers";

async function world() {
  const owner = await createUser();
  const viewer = await createUser();
  const outsider = await createUser();
  const org = await createOrg(owner);
  await addMember(org.id, viewer, "VIEWER");
  const project = await createProject(owner, org.id, "A");
  const other = await createProject(owner, org.id, "B");
  const foreignOrgProject = await createProject(outsider, undefined, "Outsider's");

  const mk = async (projectId: string) => {
    const doc = await prisma.document.create({ data: { projectId, title: "doc", type: "NOTE", status: "FAILED", processedText: "text" } });
    const chunk = await prisma.chunk.create({ data: { documentId: doc.id, projectId, content: "content", position: 0, tokenCount: 1 } });
    const synthesis = await prisma.synthesis.create({ data: { projectId, type: "FULL", status: "READY" } });
    const theme = await prisma.theme.create({ data: { synthesisId: synthesis.id, name: "t", description: "d", sentiment: "NEUTRAL", confidenceScore: 0.5 } });
    await prisma.citation.create({ data: { themeId: theme.id, chunkId: chunk.id, quote: "content", relevanceScore: 1 } });
    const rec = await prisma.recommendation.create({ data: { projectId, synthesisId: synthesis.id, title: "r", description: "d", impact: "LOW", confidence: 0.5 } });
    return { doc, synthesis, theme, rec };
  };
  return { owner, viewer, outsider, org, project, mine: await mk(project.id), theirs: await mk(other.id), foreign: await mk(foreignOrgProject.id) };
}

type W = Awaited<ReturnType<typeof world>>;
type Call = (user: TestUser, w: W) => Promise<unknown>;

const reads: Record<string, Call> = {
  "project.getById": (u, w) => callerFor(u).project.getById({ id: w.project.id }),
  "document.list": (u, w) => callerFor(u).document.list({ projectId: w.project.id }),
  "document.getById": (u, w) => callerFor(u).document.getById({ projectId: w.project.id, id: w.mine.doc.id }),
  "document.chunks": (u, w) => callerFor(u).document.chunks({ projectId: w.project.id, documentId: w.mine.doc.id }),
  "query.history": (u, w) => callerFor(u).query.history({ projectId: w.project.id }),
  "synthesis.list": (u, w) => callerFor(u).synthesis.list({ projectId: w.project.id }),
  "synthesis.getById": (u, w) => callerFor(u).synthesis.getById({ projectId: w.project.id, id: w.mine.synthesis.id }),
  "synthesis.getStatus": (u, w) => callerFor(u).synthesis.getStatus({ projectId: w.project.id, id: w.mine.synthesis.id }),
  "synthesis.themeCitations": (u, w) => callerFor(u).synthesis.themeCitations({ projectId: w.project.id, themeId: w.mine.theme.id }),
  "recommendation.list": (u, w) => callerFor(u).recommendation.list({ projectId: w.project.id }),
  "recommendation.getById": (u, w) => callerFor(u).recommendation.getById({ projectId: w.project.id, id: w.mine.rec.id }),
};

const writes: Record<string, Call> = {
  "project.update": (u, w) => callerFor(u).project.update({ id: w.project.id, name: "x" }),
  "project.delete": (u, w) => callerFor(u).project.delete({ id: w.project.id }),
  "document.getUploadUrl": (u, w) => callerFor(u).document.getUploadUrl({ projectId: w.project.id, filename: "a.txt", size: 10 }),
  "document.confirmUpload": (u, w) => callerFor(u).document.confirmUpload({ projectId: w.project.id, documentId: w.mine.doc.id, type: "NOTE" }),
  "document.importUrl": (u, w) => callerFor(u).document.importUrl({ projectId: w.project.id, url: "https://example.com/" }),
  "document.retry": (u, w) => callerFor(u).document.retry({ projectId: w.project.id, id: w.mine.doc.id }),
  "document.delete": (u, w) => callerFor(u).document.delete({ projectId: w.project.id, id: w.mine.doc.id }),
  "document.getDownloadUrl": (u, w) => callerFor(u).document.getDownloadUrl({ projectId: w.project.id, id: w.mine.doc.id }),
  "query.ask": (u, w) => callerFor(u).query.ask({ projectId: w.project.id, question: "What do customers want?" }),
  "synthesis.run": (u, w) => callerFor(u).synthesis.run({ projectId: w.project.id }),
  "recommendation.generate": (u, w) => callerFor(u).recommendation.generate({ projectId: w.project.id }),
  "recommendation.updateStatus": (u, w) => callerFor(u).recommendation.updateStatus({ projectId: w.project.id, id: w.mine.rec.id, status: "ACCEPTED" }),
  "recommendation.generateBrief": (u, w) => callerFor(u).recommendation.generateBrief({ projectId: w.project.id, id: w.mine.rec.id }),
};

/** Same procedures with an id from another project (same org) or another org. */
const foreignIds: Record<string, (u: TestUser, w: W, from: W["theirs"]) => Promise<unknown>> = {
  "document.getById": (u, w, f) => callerFor(u).document.getById({ projectId: w.project.id, id: f.doc.id }),
  "document.chunks": (u, w, f) => callerFor(u).document.chunks({ projectId: w.project.id, documentId: f.doc.id }),
  "document.confirmUpload": (u, w, f) => callerFor(u).document.confirmUpload({ projectId: w.project.id, documentId: f.doc.id, type: "NOTE" }),
  "document.retry": (u, w, f) => callerFor(u).document.retry({ projectId: w.project.id, id: f.doc.id }),
  "document.delete": (u, w, f) => callerFor(u).document.delete({ projectId: w.project.id, id: f.doc.id }),
  "document.getDownloadUrl": (u, w, f) => callerFor(u).document.getDownloadUrl({ projectId: w.project.id, id: f.doc.id }),
  "synthesis.getById": (u, w, f) => callerFor(u).synthesis.getById({ projectId: w.project.id, id: f.synthesis.id }),
  "synthesis.getStatus": (u, w, f) => callerFor(u).synthesis.getStatus({ projectId: w.project.id, id: f.synthesis.id }),
  "synthesis.themeCitations": (u, w, f) => callerFor(u).synthesis.themeCitations({ projectId: w.project.id, themeId: f.theme.id }),
  "recommendation.generate": (u, w, f) => callerFor(u).recommendation.generate({ projectId: w.project.id, synthesisId: f.synthesis.id }),
  "recommendation.getById": (u, w, f) => callerFor(u).recommendation.getById({ projectId: w.project.id, id: f.rec.id }),
  "recommendation.updateStatus": (u, w, f) => callerFor(u).recommendation.updateStatus({ projectId: w.project.id, id: f.rec.id, status: "REJECTED" }),
  "recommendation.generateBrief": (u, w, f) => callerFor(u).recommendation.generateBrief({ projectId: w.project.id, id: f.rec.id }),
};

describe("data spine authorization", () => {
  it("hides every project-scoped procedure from outsiders (NOT_FOUND)", async () => {
    const w = await world();
    for (const [name, call] of Object.entries({ ...reads, ...writes })) {
      await expect(call(w.outsider, w), name).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("rejects unauthenticated callers", async () => {
    const w = await world();
    await expect(callerFor(null).project.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerFor(null).document.list({ projectId: w.project.id })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(callerFor(null).query.ask({ projectId: w.project.id, question: "anything?" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("lets VIEWERs read everything", async () => {
    const w = await world();
    for (const [name, call] of Object.entries(reads)) {
      await expect(call(w.viewer, w), name).resolves.toBeDefined();
    }
  });

  it("blocks VIEWERs from writes and AI runs (FORBIDDEN) without side effects", async () => {
    const w = await world();
    for (const [name, call] of Object.entries(writes)) {
      await expect(call(w.viewer, w), name).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(await prisma.project.findUnique({ where: { id: w.project.id } })).not.toBeNull();
    expect(await prisma.document.count({ where: { projectId: w.project.id } })).toBe(1);
    expect(await prisma.synthesis.count({ where: { projectId: w.project.id } })).toBe(1);
    expect(await prisma.jobRun.count()).toBe(0);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: w.mine.rec.id } })).status).toBe("DRAFT");
  });

  it("rejects ids from another project or org paired with an authorized project (NOT_FOUND)", async () => {
    const w = await world();
    for (const from of [w.theirs, w.foreign]) {
      for (const [name, call] of Object.entries(foreignIds)) {
        await expect(call(w.owner, w, from), name).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    }
    // Nothing in the other projects changed.
    expect(await prisma.document.count({ where: { id: { in: [w.theirs.doc.id, w.foreign.doc.id] } } })).toBe(2);
    expect((await prisma.recommendation.findUniqueOrThrow({ where: { id: w.theirs.rec.id } })).status).toBe("DRAFT");
    expect(await prisma.jobRun.count()).toBe(0);
  });
});
