import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { recommendationWorker } from "@/workers/recommendation-worker";
import { FEATURES } from "@/server/ai/prompts";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { addMember, createOrg, createProject, createUser, type TestUser } from "../helpers/factories";
import { callerFor, eventsOfType, lastJobPayload, runWorker } from "./helpers";

async function seedSynthesis(projectId: string, opts: { themes?: boolean } = {}) {
  const doc = await prisma.document.create({ data: { projectId, title: "Interview: Dana", type: "TRANSCRIPT", status: "READY", processedText: "x" } });
  const chunk = await prisma.chunk.create({
    data: { documentId: doc.id, projectId, position: 0, tokenCount: 20, content: "Dana: The CSV export times out on large workspaces every Monday." },
  });
  const synthesis = await prisma.synthesis.create({ data: { projectId, type: "FULL", status: "READY", completedAt: new Date() } });
  if (opts.themes !== false) {
    const theme = await prisma.theme.create({
      data: { synthesisId: synthesis.id, name: "CSV export times out", description: "Large exports fail.", sentiment: "NEGATIVE", confidenceScore: 0.8 },
    });
    await prisma.citation.create({ data: { themeId: theme.id, chunkId: chunk.id, quote: "The CSV export times out on large workspaces", relevanceScore: 1 } });
  }
  return { synthesis, chunk, doc };
}

function scriptRecommendations() {
  scriptLLM(FEATURES.recommendationsGenerate, (req) => {
    expect(req.prompt).toContain("T1: CSV export times out");
    expect(req.system).toContain("untrusted_data");
    return {
      recommendations: [
        {
          title: "Make large CSV exports asynchronous",
          description: "Run exports in the background and email a link when ready.",
          impact: "HIGH",
          confidence: 0.9,
          segments: ["Enterprise admins", "Enterprise admins", ""],
          themeRefs: ["T1"],
          rationale: "Exports time out for large workspaces.",
        },
        { title: "Unsupported idea", description: "No theme backs this.", impact: "LOW", confidence: 0.99, segments: [], themeRefs: ["T99"], rationale: "None." },
      ],
    };
  });
}

async function generate(user: TestUser, projectId: string, synthesisId?: string) {
  const res = await callerFor(user).recommendation.generate({ projectId, synthesisId });
  const payload = lastJobPayload<{ jobRunId: string }>(QUEUE.RECOMMENDATIONS);
  expect(payload).toEqual({ jobRunId: res.jobRunId, projectId, synthesisId: res.synthesisId });
  return res;
}

describe("recommendations", () => {
  it("generates grounded recommendations for the same JobRun, idempotently", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const { synthesis, chunk } = await seedSynthesis(project.id);
    scriptRecommendations();

    const { jobRunId } = await generate(user, project.id);
    expect(await callerFor(user).job.get({ id: jobRunId })).toMatchObject({ status: "PENDING", kind: "RECOMMENDATIONS" });
    await runWorker(recommendationWorker, lastJobPayload(QUEUE.RECOMMENDATIONS));

    const recs = await prisma.recommendation.findMany({ where: { projectId: project.id } });
    expect(recs).toHaveLength(1); // the ungrounded one is dropped
    expect(recs[0]).toMatchObject({
      title: "Make large CSV exports asynchronous",
      impact: "HIGH",
      runId: jobRunId,
      synthesisId: synthesis.id,
      segments: ["Enterprise admins"],
      status: "DRAFT",
    });
    expect(recs[0].confidence).toBeCloseTo(0.5 * 0.9 + 0.5 * 0.8, 2);
    expect(recs[0].evidence).toMatchObject({
      themes: [{ name: "CSV export times out" }],
      quotes: [{ chunkId: chunk.id, documentTitle: "Interview: Dana", quote: "The CSV export times out on large workspaces" }],
    });
    expect(await callerFor(user).job.get({ id: jobRunId })).toMatchObject({ status: "READY" });
    expect(await eventsOfType("recommendation.created")).toHaveLength(1);

    // Retried job: replaces the run's output, no duplicates.
    await prisma.jobRun.update({ where: { id: jobRunId }, data: { status: "PROCESSING" } });
    await runWorker(recommendationWorker, lastJobPayload(QUEUE.RECOMMENDATIONS));
    expect(await prisma.recommendation.count({ where: { projectId: project.id } })).toBe(1);

    const list = await callerFor(user).recommendation.list({ projectId: project.id });
    expect(list.items[0]).toMatchObject({
      impact: "HIGH",
      hasBrief: false,
      evidence: { themes: [{ name: "CSV export times out" }], quoteCount: 1, rationale: "Exports time out for large workspaces." },
    });
  });

  it("rejects a synthesisId from another project and requires a READY synthesis", async () => {
    const user = await createUser();
    const a = await createProject(user, undefined, "A");
    const b = await createProject(user, undefined, "B");
    const { synthesis: foreign } = await seedSynthesis(b.id);
    await expect(callerFor(user).recommendation.generate({ projectId: a.id, synthesisId: foreign.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(user).recommendation.generate({ projectId: a.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(jobsFor(QUEUE.RECOMMENDATIONS)).toHaveLength(0);
    expect(await prisma.jobRun.count()).toBe(0);
  });

  it("fails the JobRun with a reason when the synthesis has no themes", async () => {
    const user = await createUser();
    const project = await createProject(user);
    await seedSynthesis(project.id, { themes: false });
    const { jobRunId } = await generate(user, project.id);
    await expect(runWorker(recommendationWorker, lastJobPayload(QUEUE.RECOMMENDATIONS))).rejects.toThrow();
    expect(await callerFor(user).job.get({ id: jobRunId })).toMatchObject({
      status: "FAILED",
      errorMessage: "The synthesis has no themes to base recommendations on",
    });
  });

  it("changes status with an event carrying from/to", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const rec = await prisma.recommendation.create({ data: { projectId: project.id, title: "Do X", description: "d", impact: "MEDIUM", confidence: 0.5 } });
    const caller = callerFor(user);
    await caller.recommendation.updateStatus({ projectId: project.id, id: rec.id, status: "ACCEPTED" });
    await caller.recommendation.updateStatus({ projectId: project.id, id: rec.id, status: "ACCEPTED" });
    await caller.recommendation.updateStatus({ projectId: project.id, id: rec.id, status: "IMPLEMENTED" });
    const events = await eventsOfType("recommendation.status_changed");
    expect(events.map((e) => e.payload)).toEqual([
      { recommendationId: rec.id, title: "Do X", from: "DRAFT", to: "ACCEPTED" },
      { recommendationId: rec.id, title: "Do X", from: "ACCEPTED", to: "IMPLEMENTED" },
    ]);
  });

  it("generates, stores and reuses feature briefs", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, viewer, "VIEWER");
    const project = await createProject(owner, org.id);
    await seedSynthesis(project.id);
    scriptRecommendations();
    await generate(owner, project.id);
    await runWorker(recommendationWorker, lastJobPayload(QUEUE.RECOMMENDATIONS));
    const rec = await prisma.recommendation.findFirstOrThrow({ where: { projectId: project.id } });

    await expect(callerFor(viewer).recommendation.generateBrief({ projectId: project.id, id: rec.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    scriptLLM(FEATURES.recommendationsBrief, (req) => {
      expect(req.prompt).toContain("The CSV export times out on large workspaces");
      return {
        title: "Async CSV exports",
        problemStatement: "Exports time out for large workspaces.",
        userStories: [{ persona: "Workspace admin", action: "export all rows", benefit: "I can run the Monday review", acceptanceCriteria: ["Export of 100k rows succeeds"] }],
        requirements: [{ id: "weird", priority: "P0", description: "Background export job", acceptanceCriteria: ["Emails a link"] }],
        successMetrics: [{ metric: "Export success rate", targetValue: "99%", measuringMethod: "Job logs" }],
        openQuestions: ["Retention for export files?"],
        risks: ["Email deliverability"],
        impactedSegments: [],
        expectedImpact: "high",
      };
    });
    const first = await callerFor(owner).recommendation.generateBrief({ projectId: project.id, id: rec.id });
    expect(first.generated).toBe(true);
    expect(first.brief).toMatchObject({
      recommendationId: rec.id,
      title: "Async CSV exports",
      requirements: [{ id: "P0-1", priority: "P0" }],
      impactedSegments: ["Enterprise admins"],
      evidenceAppendix: [{ quotes: [{ text: "The CSV export times out on large workspaces", context: "Interview: Dana" }] }],
    });

    const callsBefore = llmCalls.length;
    const again = await callerFor(viewer).recommendation.generateBrief({ projectId: project.id, id: rec.id });
    expect(again.generated).toBe(false);
    expect(llmCalls.length).toBe(callsBefore);
    const detail = await callerFor(viewer).recommendation.getById({ projectId: project.id, id: rec.id });
    expect(detail.brief?.title).toBe("Async CSV exports");
    expect(detail.hasBrief).toBe(true);

    const regenerated = await callerFor(owner).recommendation.generateBrief({ projectId: project.id, id: rec.id, regenerate: true });
    expect(regenerated.generated).toBe(true);
    expect(llmCalls.length).toBe(callsBefore + 1);
  });
});

describe("recommendations learn from shipped outcomes", () => {
  it("includes the project's outcome learnings in the prompt once outcomes are measured", async () => {
    const user = await createUser();
    const project = await createProject(user);
    await seedSynthesis(project.id);
    // Three shipped + measured recommendations (MIN_MEASURED_FOR_ADJUSTMENT = 3), two met their target.
    for (const [i, current] of [10, 12, 4].entries()) {
      const rec = await prisma.recommendation.create({
        data: { projectId: project.id, title: `Past rec ${i}`, description: "d", impact: "HIGH", confidence: 0.7, status: "IMPLEMENTED" },
      });
      await prisma.outcomeTracking.create({
        data: { recommendationId: rec.id, status: "MEASURED", metricName: "activation", baselineValue: 2, currentValue: current, targetValue: 10 },
      });
    }
    let sawLearning = false;
    scriptLLM(FEATURES.recommendationsGenerate, (req) => {
      sawLearning = req.prompt.includes("Outcomes of this project's previously shipped recommendations");
      return {
        recommendations: [
          { title: "Async exports", description: "Background exports.", impact: "HIGH", confidence: 0.8, segments: [], themeRefs: ["T1"], rationale: "Timeouts." },
        ],
      };
    });
    const { jobRunId } = await generate(user, project.id);
    await runWorker(recommendationWorker, lastJobPayload(QUEUE.RECOMMENDATIONS));
    expect(sawLearning).toBe(true);
    const created = await prisma.recommendation.findMany({ where: { runId: jobRunId } });
    expect(created).toHaveLength(1);
    expect(created[0].confidence).toBeGreaterThan(0);
    expect(created[0].confidence).toBeLessThanOrEqual(1);
  });
});
