import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { runJob } from "@/server/jobs/worker";
import { LLMError, type GenerateObjectRequest } from "@/server/ai/client";
import type { z } from "zod";
import { knowledgeWorker } from "@/workers/knowledge-worker";
import { knowledgeSubscriber } from "@/server/events/subscribers/knowledge";
import { ensureEntityEmbeddings, knowledgeRunId, processDocumentKnowledge } from "@/server/ai/knowledge/pipeline";
import { suggestMerges } from "@/server/ai/knowledge/duplicates";
import { verifyQuote } from "@/server/ai/knowledge/text";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { chunksInPrompt, documentWithChunks, domainEvent, expectTRPCCode, insightsCaller, testLog } from "./helpers";

type Req = GenerateObjectRequest<z.ZodType>;

/** Fake extractor: entities by keyword, relations quoting the chunk text verbatim (plus one fabricated quote). */
function scriptExtraction() {
  scriptLLM("knowledge.extract", (req: Req) => {
    const chunks = chunksInPrompt(req.prompt);
    const entities: unknown[] = [];
    const relations: unknown[] = [];
    for (const c of chunks) {
      if (c.text.includes("Acme")) entities.push({ name: "Acme Corp", type: "COMPANY", description: "Customer company", aliases: ["Acme"], chunkRefs: [c.label], confidence: 0.9 });
      if (c.text.includes("CSV export")) entities.push({ name: "CSV export", type: "FEATURE", description: "Exporting reports to CSV", aliases: [], chunkRefs: [c.label], confidence: 0.8 });
      if (c.text.includes("slow dashboards")) entities.push({ name: "Slow dashboards", type: "PAIN_POINT", description: "Dashboards load slowly", aliases: [], chunkRefs: [c.label], confidence: 0.8 });
      if (c.text.includes("Acme") && c.text.includes("CSV export")) {
        const start = c.text.indexOf("Acme");
        relations.push({ source: "CSV export", target: "Acme Corp", type: "USED_BY", strength: 0.7, chunkRef: c.label, quote: c.text.slice(start, start + 40) });
      }
      if (c.text.includes("slow dashboards") && c.text.includes("Acme")) {
        relations.push({ source: "Slow dashboards", target: "Acme Corp", type: "RELATES_TO", strength: 0.6, chunkRef: c.label, quote: "This sentence does not appear in the chunk at all" });
      }
    }
    return { entities, relations };
  });
}

async function setupOrg() {
  const owner = await createUser();
  const org = await createOrg(owner);
  const project = await createProject(owner, org.id);
  return { owner, org, project };
}

async function extractDoc(projectId: string, chunks: string[]) {
  const { documentId, chunkIds } = await documentWithChunks(projectId, { title: "Acme interview", chunks });
  await processDocumentKnowledge(documentId, testLog);
  return { documentId, chunkIds };
}

const CHUNKS = [
  "Acme Corp relies on CSV export every Monday to share numbers with finance.",
  "The team at Acme complained about slow dashboards during the quarterly review.",
];

describe("knowledge worker", () => {
  it("extracts entities and verified relations, then is idempotent on re-run", async () => {
    const { org, project } = await setupOrg();
    scriptExtraction();
    const { documentId, chunkIds } = await extractDoc(project.id, CHUNKS);

    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: knowledgeRunId(documentId) } });
    expect(run.status).toBe("READY");
    expect(run.kind).toBe("KNOWLEDGE_EXTRACTION");

    const entities = await prisma.knowledgeEntity.findMany({ where: { orgId: org.id }, orderBy: { name: "asc" } });
    expect(entities.map((e) => e.name)).toEqual(["Acme Corp", "CSV export", "Slow dashboards"]);
    const acme = entities.find((e) => e.name === "Acme Corp")!;
    expect(acme.mentionCount).toBe(2); // mentioned in both chunks
    expect(acme.normalizedName).toBe("acme corp");

    const links = await prisma.knowledgeNode_Project.count({ where: { projectId: project.id } });
    expect(links).toBe(3);

    // Only the relation whose quote is a real substring survives.
    const relations = await prisma.knowledgeRelation.findMany({ where: { source: { orgId: org.id } } });
    expect(relations).toHaveLength(1);
    const rel = relations[0];
    expect(rel.type).toBe("USED_BY");
    expect(rel.evidenceChunkIds).toEqual([chunkIds[0]]);
    expect(rel.evidenceDocuments).toEqual([documentId]);
    const quotes = rel.evidenceQuotes as Array<{ chunkId: string; quote: string }>;
    expect(quotes).toHaveLength(1);
    expect(CHUNKS[0]).toContain(quotes[0].quote);
    expect((run.output as { unverifiedRelations: number }).unverifiedRelations).toBe(1);

    // Embeddings written via raw SQL with the model recorded.
    const embedded = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM knowledge_entities WHERE "orgId" = ${org.id} AND embedding IS NOT NULL AND "embeddingModel" IS NOT NULL`;
    expect(embedded[0].n).toBe(3);

    const events = await prisma.domainEvent.findMany({ where: { orgId: org.id, type: "knowledge.extracted" } });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ documentId, entityCount: 3, relationCount: 1 });

    // Re-run: same content -> no LLM calls, no count drift, no duplicates, no second event.
    const callsBefore = llmCalls.length;
    await processDocumentKnowledge(documentId, testLog);
    expect(llmCalls.length).toBe(callsBefore);
    const again = await prisma.knowledgeEntity.findMany({ where: { orgId: org.id } });
    expect(again).toHaveLength(3);
    expect(again.find((e) => e.id === acme.id)!.mentionCount).toBe(2);
    expect(await prisma.knowledgeRelation.count({ where: { source: { orgId: org.id } } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { orgId: org.id, type: "knowledge.extracted" } })).toBe(1);
  });

  it("re-processing changed content replaces the document's previous contribution", async () => {
    const { org, project } = await setupOrg();
    scriptExtraction();
    const { documentId } = await extractDoc(project.id, CHUNKS);

    // The document is re-chunked with different content (e.g. an integration re-sync).
    await prisma.chunk.deleteMany({ where: { documentId } });
    const { addChunks } = await import("./helpers");
    await addChunks(documentId, project.id, ["Acme Corp asked for CSV export to include custom fields."]);
    await processDocumentKnowledge(documentId, testLog);

    const entities = await prisma.knowledgeEntity.findMany({ where: { orgId: org.id }, orderBy: { name: "asc" } });
    expect(entities.map((e) => [e.name, e.mentionCount])).toEqual([
      ["Acme Corp", 1],
      ["CSV export", 1],
    ]); // "Slow dashboards" was only in the old content and is gone
    const rel = await prisma.knowledgeRelation.findMany({ where: { source: { orgId: org.id } } });
    expect(rel).toHaveLength(1);
    expect(rel[0].evidenceDocuments).toEqual([documentId]);
  });

  it("counts mentions across documents and records skipped chunks", async () => {
    const { org, project } = await setupOrg();
    scriptExtraction();
    await extractDoc(project.id, CHUNKS);
    const second = await documentWithChunks(project.id, { chunks: ["Acme Corp renewed after the CSV export fix.", "   "] });
    await processDocumentKnowledge(second.documentId, testLog);

    const acme = await prisma.knowledgeEntity.findFirstOrThrow({ where: { orgId: org.id, normalizedName: "acme corp" } });
    expect(acme.mentionCount).toBe(3);
    const rel = await prisma.knowledgeRelation.findFirstOrThrow({ where: { source: { orgId: org.id }, type: "USED_BY" } });
    expect(rel.evidenceDocuments).toHaveLength(2);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: knowledgeRunId(second.documentId) } });
    expect(run.output).toMatchObject({ chunkCount: 2, processedChunks: 1, skippedChunks: 1, skipped: [{ reason: "empty" }] });
  });

  it("records failed batches as skipped and fails the run when every batch fails", async () => {
    const { project } = await setupOrg();
    scriptLLM("knowledge.extract", () => {
      throw new LLMError("The model declined this request (knowledge.extract)", "refusal");
    });
    const { documentId } = await documentWithChunks(project.id, { chunks: CHUNKS });
    await expect(
      runJob(knowledgeWorker, { documentId }, { jobId: "t1", attempt: 1, maxAttempts: 3 })
    ).rejects.toThrow();
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: knowledgeRunId(documentId) } });
    expect(run.status).toBe("FAILED");
    expect(run.errorMessage).toMatch(/failed for every part/);
    expect(await prisma.knowledgeEntity.count()).toBe(0);
  });

  it("suggests merges for near-duplicate entities without merging them", async () => {
    const { org } = await setupOrg();
    const description = "collaborative workspace notes wiki documents product team planning roadmap specs meetings knowledge";
    const a = await prisma.knowledgeEntity.create({ data: { orgId: org.id, type: "COMPANY", name: "Notion", normalizedName: "notion", description, confidence: 0.9, mentionCount: 5 } });
    const b = await prisma.knowledgeEntity.create({ data: { orgId: org.id, type: "COMPETITOR", name: "Notion", normalizedName: "notion", description, confidence: 0.9, mentionCount: 2 } });
    const unrelated = await prisma.knowledgeEntity.create({ data: { orgId: org.id, type: "FEATURE", name: "SSO login", normalizedName: "sso login", description: "single sign on with okta", confidence: 0.9 } });
    await ensureEntityEmbeddings(org.id, null, [a.id, b.id, unrelated.id]);
    const created = await suggestMerges(org.id, [b.id, a.id], testLog);
    expect(created).toBe(1);
    const s = await prisma.knowledgeMergeSuggestion.findFirstOrThrow({ where: { orgId: org.id } });
    expect(s.status).toBe("PENDING");
    expect([s.targetId, s.sourceId]).toEqual([a.id, b.id]); // more mentions -> kept as target
    expect(await prisma.knowledgeEntity.count({ where: { orgId: org.id } })).toBe(3); // nothing auto-merged
    // Deterministic and idempotent.
    expect(await suggestMerges(org.id, [a.id, b.id], testLog)).toBe(0);
  });
});

describe("knowledge subscriber", () => {
  it("enqueues extraction for document.ready once per event", async () => {
    const { org, project } = await setupOrg();
    const { documentId } = await documentWithChunks(project.id, { chunks: CHUNKS });
    const event = await domainEvent({ orgId: org.id, projectId: project.id, type: "document.ready", payload: { documentId, title: "x", chunkCount: 2 } });
    expect(knowledgeSubscriber.handles("document.ready")).toBe(true);
    expect(knowledgeSubscriber.handles("document.failed")).toBe(false);
    await knowledgeSubscriber.handle(event, testLog);
    await knowledgeSubscriber.handle(event, testLog); // redelivery
    const jobs = jobsFor(QUEUE.KNOWLEDGE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ documentId });
    expect(jobs[0].opts.jobId).toBe(`kg_${documentId}_${event.id}`);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: knowledgeRunId(documentId) } });
    expect(run).toMatchObject({ status: "PENDING", orgId: org.id, projectId: project.id, kind: "KNOWLEDGE_EXTRACTION" });
  });

  it("ignores events whose document is not in the event's org", async () => {
    const { project } = await setupOrg();
    const other = await createUser();
    const { documentId } = await documentWithChunks(project.id, { chunks: CHUNKS });
    const event = await domainEvent({ orgId: other.personalOrgId, projectId: null, type: "document.ready", payload: { documentId, title: "x", chunkCount: 2 } });
    await knowledgeSubscriber.handle(event, testLog);
    expect(jobsFor(QUEUE.KNOWLEDGE)).toHaveLength(0);
  });
});

describe("knowledge router authorization", () => {
  async function graphFixture() {
    const f = await setupOrg();
    scriptExtraction();
    await extractDoc(f.project.id, CHUNKS);
    const entities = await prisma.knowledgeEntity.findMany({ where: { orgId: f.org.id }, orderBy: { name: "asc" } });
    return { ...f, acme: entities[0], csv: entities[1], slow: entities[2] };
  }

  it("previously open procedures return NOT_FOUND across orgs", async () => {
    const { org, acme, csv } = await graphFixture();
    const outsider = await createUser();
    const asOutsider = insightsCaller(outsider); // acting in the outsider's own org
    await expectTRPCCode(asOutsider.knowledge.getEntity({ entityId: acme.id }), "NOT_FOUND");
    await expectTRPCCode(asOutsider.knowledge.getEntityNeighborhood({ entityId: acme.id, depth: 2 }), "NOT_FOUND");
    await expectTRPCCode(asOutsider.knowledge.getRelations({ entityId: acme.id }), "NOT_FOUND");
    await expectTRPCCode(asOutsider.knowledge.findShortestPath({ sourceId: acme.id, targetId: csv.id }), "NOT_FOUND");
    // Naming the victim org explicitly is rejected by membership.
    await expectTRPCCode(insightsCaller(outsider, org.id).knowledge.getEntity({ entityId: acme.id }), "NOT_FOUND");
    await expectTRPCCode(asOutsider.knowledge.getEntity({ orgId: org.id, entityId: acme.id }), "NOT_FOUND");
    // A path with one endpoint in the caller's own org is not reachable either.
    const own = await prisma.knowledgeEntity.create({ data: { orgId: outsider.personalOrgId, type: "CONCEPT", name: "Mine", normalizedName: "mine", confidence: 1 } });
    await expectTRPCCode(asOutsider.knowledge.findShortestPath({ sourceId: own.id, targetId: acme.id }), "NOT_FOUND");
    // Lists never include another org's entities.
    const list = await asOutsider.knowledge.listEntities({});
    expect(list.items.map((e) => e.id)).toEqual([own.id]);
  });

  it("members can read the graph of their org", async () => {
    const { owner, org, acme, csv, slow } = await graphFixture();
    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    const api = insightsCaller(viewer, org.id);
    const entity = await api.knowledge.getEntity({ entityId: acme.id });
    expect(entity.name).toBe("Acme Corp");
    expect(entity.mentions.length).toBeGreaterThan(0);
    expect(entity.permissions).toEqual({ canWrite: false, canDelete: false });
    const hood = await api.knowledge.getEntityNeighborhood({ entityId: acme.id, depth: 2 });
    expect(hood.nodes.map((n) => n.id).sort()).toEqual([acme.id, csv.id].sort());
    const rels = await api.knowledge.getRelations({ entityId: acme.id });
    expect(rels.items[0].evidence[0]).toMatchObject({ projectId: expect.any(String), documentId: expect.any(String) });
    const path = await api.knowledge.findShortestPath({ sourceId: csv.id, targetId: acme.id });
    expect(path.found).toBe(true);
    expect(path.steps.map((s) => s.node.id)).toEqual([csv.id, acme.id]);
    const none = await api.knowledge.findShortestPath({ sourceId: slow.id, targetId: csv.id });
    expect(none).toEqual({ found: false, steps: [] });
    const stats = await insightsCaller(owner, org.id).knowledge.getStats();
    expect(stats).toMatchObject({ entityCount: 3, relationCount: 1, permissions: { canWrite: true, canDelete: true } });
    const hubs = await api.knowledge.getTopHubs({ limit: 5 });
    expect(hubs[0].degree).toBe(1);
  });

  it("merge suggestions: cross-org targets rejected, viewers blocked, members merge", async () => {
    const { owner, org, acme, csv } = await graphFixture();
    const outsider = await createUser();
    const theirs = await prisma.knowledgeEntity.create({ data: { orgId: outsider.personalOrgId, type: "COMPANY", name: "Acme", normalizedName: "acme", confidence: 1 } });
    // A suggestion in the outsider's org that points at the victim's entity (IDOR attempt).
    const forged = await prisma.knowledgeMergeSuggestion.create({ data: { orgId: outsider.personalOrgId, sourceId: theirs.id, targetId: acme.id, similarity: 0.99 } });
    await expectTRPCCode(insightsCaller(outsider).knowledge.acceptMergeSuggestion({ suggestionId: forged.id }), "NOT_FOUND");
    await expectTRPCCode(insightsCaller(outsider).knowledge.acceptMergeSuggestion({ suggestionId: forged.id, keep: "source" }), "NOT_FOUND");
    expect(await prisma.knowledgeEntity.findUnique({ where: { id: acme.id } })).not.toBeNull();
    expect((await prisma.knowledgeEntity.findUniqueOrThrow({ where: { id: acme.id } })).mentionCount).toBe(2);

    // The victim's own suggestion is invisible to the outsider.
    const dup = await prisma.knowledgeEntity.create({ data: { orgId: org.id, type: "COMPANY", name: "ACME Corporation", normalizedName: "acme corporation", confidence: 0.8, mentionCount: 1 } });
    const real = await prisma.knowledgeMergeSuggestion.create({ data: { orgId: org.id, sourceId: dup.id, targetId: acme.id, similarity: 0.95 } });
    await expectTRPCCode(insightsCaller(outsider).knowledge.acceptMergeSuggestion({ suggestionId: real.id }), "NOT_FOUND");
    await expectTRPCCode(insightsCaller(outsider).knowledge.rejectMergeSuggestion({ suggestionId: real.id }), "NOT_FOUND");
    // Neither the victim's suggestion nor the forged one (foreign target) is listed.
    expect((await insightsCaller(outsider).knowledge.listMergeSuggestions({})).items).toHaveLength(0);
    expect((await insightsCaller(owner, org.id).knowledge.listMergeSuggestions({})).items.map((s) => s.id)).toEqual([real.id]);

    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    await expectTRPCCode(insightsCaller(viewer, org.id).knowledge.acceptMergeSuggestion({ suggestionId: real.id }), "FORBIDDEN");

    // Relation pointing at the duplicate gets re-pointed on merge.
    await prisma.knowledgeRelation.create({ data: { sourceId: csv.id, targetId: dup.id, type: "PART_OF", strength: 0.5, evidenceDocuments: [], evidenceChunkIds: [] } });
    const member = await createUser();
    await addMember(org.id, member, "MEMBER");
    const res = await insightsCaller(member, org.id).knowledge.acceptMergeSuggestion({ suggestionId: real.id });
    expect(res).toEqual({ mergedIntoId: acme.id, removedId: dup.id });
    expect(await prisma.knowledgeEntity.findUnique({ where: { id: dup.id } })).toBeNull();
    const merged = await prisma.knowledgeEntity.findUniqueOrThrow({ where: { id: acme.id } });
    expect(merged.mentionCount).toBe(3);
    expect(merged.aliases).toContain("ACME Corporation");
    expect(await prisma.knowledgeRelation.count({ where: { sourceId: csv.id, targetId: acme.id, type: "PART_OF" } })).toBe(1);

    // Deleting requires ADMIN.
    await expectTRPCCode(insightsCaller(member, org.id).knowledge.deleteEntity({ entityId: csv.id }), "FORBIDDEN");
    await expectTRPCCode(insightsCaller(outsider).knowledge.deleteEntity({ entityId: csv.id }), "NOT_FOUND");
    await insightsCaller(owner, org.id).knowledge.deleteEntity({ entityId: csv.id });
    expect(await prisma.knowledgeEntity.findUnique({ where: { id: csv.id } })).toBeNull();
  });

  it("natural-language query cites only retrieved entities and is persisted", async () => {
    const { owner, org, acme } = await graphFixture();
    scriptLLM("knowledge.query", (req: Req) => {
      expect(req.prompt).toContain("Acme Corp");
      return { answer: "Acme Corp depends on CSV export.", citedEntities: ["E1", "E99"], insights: ["Prioritise export reliability"], confidence: 0.8 };
    });
    const res = await insightsCaller(owner, org.id).knowledge.query({ question: "Which customers use CSV export?" });
    expect(res.answer).toContain("Acme");
    expect(res.citedEntities).toHaveLength(1); // E99 was not retrieved and is dropped
    const stored = await prisma.knowledgeQuery.findUniqueOrThrow({ where: { id: res.queryId } });
    expect(stored).toMatchObject({ orgId: org.id, userId: owner.id });
    const recent = await insightsCaller(owner, org.id).knowledge.getRecentQueries({});
    expect(recent.items[0]).toMatchObject({ id: res.queryId, citedCount: 1 });
    // Another member's history does not include it.
    const other = await createUser();
    await addMember(org.id, other, "MEMBER");
    expect((await insightsCaller(other, org.id).knowledge.getRecentQueries({})).items).toHaveLength(0);
    expect(acme.id).toBeTruthy();
  });
});

describe("knowledge text helpers", () => {
  it("verifies quotes as whitespace/case-insensitive substrings", () => {
    expect(verifyQuote("relies on  CSV export", "Acme Corp relies on CSV export every Monday")).toBe("relies on CSV export");
    expect(verifyQuote("relies on PDF export", "Acme Corp relies on CSV export every Monday")).toBeNull();
    expect(verifyQuote("short", "short")).toBeNull();
  });
});
