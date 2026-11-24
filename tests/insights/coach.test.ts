import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { runJob } from "@/server/jobs/worker";
import { LLMError } from "@/server/ai/client";
import { coachingWorker } from "@/workers/coaching-worker";
import { coachSubscriber } from "@/server/events/subscribers/coach";
import { runCoaching, isDuplicateTitle } from "@/server/ai/coach/generate";
import { findIgnoredThemes } from "@/server/ai/coach/context";
import { run as scheduleCoach } from "@/server/schedules/coach";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { addMember, createOrg, createProject, createReadyDocument, createUser } from "../helpers/factories";
import { domainEvent, expectTRPCCode, insightsCaller, testLog } from "./helpers";

async function fixture() {
  const owner = await createUser();
  const org = await createOrg(owner);
  const project = await createProject(owner, org.id);
  return { owner, org, project };
}

function scriptCoach(titles = ["Validate the export theme with RICE", "Track outcomes for accepted work"]) {
  scriptLLM("coach.insights", () => ({
    summary: "The team ships recommendations but rarely measures outcomes.",
    insights: titles.map((title, i) => ({
      type: i === 0 ? "FRAMEWORK_SUGGESTION" : "PROCESS_IMPROVEMENT",
      priority: "HIGH",
      title,
      message: "Two accepted recommendations have no outcome tracking, so you cannot learn from them.",
      rationale: "acceptedWithoutOutcome = 2",
      actionItems: ["Add a success metric to each accepted recommendation"],
      framework: i === 0 ? "RICE" : null,
    })),
  }));
}

describe("coach router", () => {
  it("requestCoaching is asynchronous: returns a jobRunId and makes no LLM call", async () => {
    const { owner, project } = await fixture();
    const api = insightsCaller(owner);
    const res = await api.coach.requestCoaching({ projectId: project.id });
    expect(res.deduplicated).toBe(false);
    expect(llmCalls).toHaveLength(0);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: res.jobRunId } });
    expect(run).toMatchObject({ kind: "COACHING", status: "PENDING", projectId: project.id, createdById: owner.id });
    expect(jobsFor(QUEUE.COACHING).map((j) => j.payload)).toEqual([{ jobRunId: res.jobRunId }]);
    // Double submit returns the in-flight run.
    expect(await api.coach.requestCoaching({ projectId: project.id })).toEqual({ jobRunId: res.jobRunId, deduplicated: true });
    expect((await api.job.get({ id: res.jobRunId })).status).toBe("PENDING");
  });

  it("requires MEMBER for requestCoaching and hides projects from outsiders", async () => {
    const { org, project } = await fixture();
    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    await expectTRPCCode(insightsCaller(viewer).coach.requestCoaching({ projectId: project.id }), "FORBIDDEN");
    const outsider = await createUser();
    await expectTRPCCode(insightsCaller(outsider).coach.requestCoaching({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(insightsCaller(outsider).coach.getInsights({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(insightsCaller(outsider).coach.getActivityAnalysis({ projectId: project.id }), "NOT_FOUND");
    await expectTRPCCode(insightsCaller(outsider).coach.getCoachingHistory({ projectId: project.id }), "NOT_FOUND");
    expect(jobsFor(QUEUE.COACHING)).toHaveLength(0);
  });

  it("only the owner of an insight can dismiss or action it", async () => {
    const { owner, org, project } = await fixture();
    const colleague = await createUser();
    await addMember(org.id, colleague, "ADMIN");
    const insight = await prisma.coachInsight.create({ data: { userId: owner.id, projectId: project.id, type: "NUDGE", title: "Mine", message: "m" } });
    await expectTRPCCode(insightsCaller(colleague).coach.dismissInsight({ insightId: insight.id }), "NOT_FOUND");
    await expectTRPCCode(insightsCaller(colleague).coach.actionInsight({ insightId: insight.id }), "NOT_FOUND");
    expect((await insightsCaller(colleague).coach.getInsights({ projectId: project.id })).items).toHaveLength(0);
    expect(await insightsCaller(owner).coach.dismissInsight({ insightId: insight.id })).toEqual({ id: insight.id, status: "DISMISSED" });

    // An owner who has left the org can no longer act on project insights.
    const other = await prisma.coachInsight.create({ data: { userId: colleague.id, projectId: project.id, type: "NUDGE", title: "Theirs", message: "m" } });
    await prisma.orgMember.deleteMany({ where: { orgId: org.id, userId: colleague.id } });
    await expectTRPCCode(insightsCaller(colleague).coach.actionInsight({ insightId: other.id }), "NOT_FOUND");
    expect((await insightsCaller(colleague).coach.getInsights({})).items).toHaveLength(0);
  });

  it("lists insights with a new count and marks displayed ones as seen", async () => {
    const { owner, project } = await fixture();
    const a = await prisma.coachInsight.create({ data: { userId: owner.id, projectId: project.id, type: "NUDGE", title: "One", message: "m", evidence: { actionItems: ["Do it"] } } });
    await prisma.coachInsight.create({ data: { userId: owner.id, projectId: project.id, type: "WARNING", title: "Two", message: "m", status: "DISMISSED" } });
    const api = insightsCaller(owner);
    const open = await api.coach.getInsights({ projectId: project.id });
    expect(open.items.map((i) => i.id)).toEqual([a.id]);
    expect(open.items[0].actionItems).toEqual(["Do it"]);
    expect(open.newCount).toBe(1);
    expect((await api.coach.getInsights({ projectId: project.id, view: "all" })).items).toHaveLength(2);
    expect(await api.coach.markSeen({ insightIds: [a.id] })).toEqual({ updated: 1 });
    expect((await api.coach.getInsights({ projectId: project.id })).newCount).toBe(0);
  });
});

describe("coaching worker", () => {
  it("generates insights for the requester, records a session, and is idempotent", async () => {
    const { owner, org, project } = await fixture();
    await createReadyDocument(project.id, "Interview", "We need CSV export");
    scriptCoach();
    const { jobRunId } = await insightsCaller(owner).coach.requestCoaching({ projectId: project.id });
    const out = await runCoaching(jobRunId, testLog);
    expect(out).toMatchObject({ insightsCreated: 2, recipients: 1, skippedDuplicates: 0, trigger: "manual" });
    const insights = await prisma.coachInsight.findMany({ where: { userId: owner.id, projectId: project.id } });
    expect(insights).toHaveLength(2);
    expect(insights[0].evidence).toMatchObject({ jobRunId });
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } })).status).toBe("READY");

    const calls = llmCalls.length;
    await runCoaching(jobRunId, testLog); // redelivered job
    expect(llmCalls.length).toBe(calls);
    expect(await prisma.coachInsight.count({ where: { userId: owner.id } })).toBe(2);

    const history = await insightsCaller(owner).coach.getCoachingHistory({ projectId: project.id });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ trigger: "manual", project: { id: project.id } });
    expect(history.items[0].insights.map((i) => i.title)).toContain("Track outcomes for accepted work");

    // A later run that repeats the same advice is deduplicated against recent insights.
    const second = await prisma.jobRun.create({ data: { kind: "COACHING", orgId: org.id, projectId: project.id, createdById: owner.id, status: "PENDING", input: { trigger: "manual" } } });
    const again = await runCoaching(second.id, testLog);
    expect(again).toMatchObject({ insightsCreated: 0, skippedDuplicates: 2 });
    expect(await prisma.coachInsight.count({ where: { userId: owner.id } })).toBe(2);
  });

  it("creates an onboarding nudge without an LLM call when the project has no feedback", async () => {
    const { owner, org, project } = await fixture();
    const run = await prisma.jobRun.create({ data: { kind: "COACHING", orgId: org.id, projectId: project.id, createdById: owner.id, status: "PENDING" } });
    await runCoaching(run.id, testLog);
    expect(llmCalls).toHaveLength(0);
    const insights = await prisma.coachInsight.findMany({ where: { userId: owner.id } });
    expect(insights.map((i) => i.type)).toEqual(["NUDGE"]);
  });

  it("marks the run FAILED when generation fails", async () => {
    const { owner, org, project } = await fixture();
    await createReadyDocument(project.id, "Interview", "text");
    scriptLLM("coach.insights", () => {
      throw new LLMError("The model declined this request (coach.insights)", "refusal");
    });
    const run = await prisma.jobRun.create({ data: { kind: "COACHING", orgId: org.id, projectId: project.id, createdById: owner.id, status: "PENDING" } });
    await expect(runJob(coachingWorker, { jobRunId: run.id }, { jobId: "c1", attempt: 1, maxAttempts: 3 })).rejects.toThrow();
    const after = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after.status).toBe("FAILED");
    expect(await prisma.coachInsight.count()).toBe(0);
  });
});

describe("coach subscriber and scheduler", () => {
  it("records activity and schedules at most one automatic run per interval", async () => {
    const { owner, org, project } = await fixture();
    expect(coachSubscriber.handles("synthesis.completed")).toBe(true);
    expect(coachSubscriber.handles("comment.created")).toBe(false);
    const e1 = await domainEvent({ orgId: org.id, projectId: project.id, type: "recommendation.created", payload: { recommendationId: "r1", title: "t", impact: "HIGH", confidence: 0.9 }, actorUserId: owner.id });
    await coachSubscriber.handle(e1, testLog);
    await coachSubscriber.handle(e1, testLog); // redelivery
    const e2 = await domainEvent({ orgId: org.id, projectId: project.id, type: "synthesis.completed", payload: { synthesisId: "s1", themeCount: 3 } });
    await coachSubscriber.handle(e2, testLog);
    const runs = await prisma.jobRun.findMany({ where: { projectId: project.id, kind: "COACHING" } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "PENDING", createdById: null, input: { trigger: "event", eventType: "recommendation.created" } });
    expect(jobsFor(QUEUE.COACHING)).toHaveLength(1);
    expect(llmCalls).toHaveLength(0);

    // The automatic run targets recently active members.
    await createReadyDocument(project.id, "Interview", "text");
    scriptCoach(["Review stale drafts weekly"]);
    const out = await runCoaching(runs[0].id, testLog);
    expect(out).toMatchObject({ recipients: 1, insightsCreated: 1, trigger: "event" });
    const analysis = await insightsCaller(owner).coach.getActivityAnalysis({ projectId: project.id });
    expect(analysis.activity["recommendation.created"]).toBe(1);
    expect(analysis.counts.documents).toBe(1);
  });

  it("schedules weekday digests for active projects only", async () => {
    const { project } = await fixture();
    await fixture(); // an idle project
    await prisma.document.create({
      data: { projectId: project.id, title: "Interview", type: "TRANSCRIPT", status: "READY", processedText: "text", createdAt: new Date("2026-11-17T10:00:00Z") },
    });
    expect(await scheduleCoach(new Date("2026-11-22T08:45:00Z"))).toBe(0); // Sunday: no digests
    const wednesday = new Date("2026-11-18T08:45:00Z");
    expect(await scheduleCoach(wednesday)).toBe(1);
    expect(jobsFor(QUEUE.COACHING)).toHaveLength(1);
    expect(await scheduleCoach(wednesday)).toBe(0); // already ran within the interval
  });
});

describe("coach pure logic", () => {
  it("detects duplicate titles and ignored themes", () => {
    expect(isDuplicateTitle("Track outcomes for accepted work", ["Track outcomes of accepted work"])).toBe(true);
    expect(isDuplicateTitle("Interview churned customers", ["Track outcomes of accepted work"])).toBe(false);
    const themes = [
      { id: "1", name: "Slow CSV export", description: "", sentiment: "NEGATIVE", confidenceScore: 0.9, citationCount: 5, sampleQuotes: [] },
      { id: "2", name: "Onboarding friction", description: "", sentiment: "NEGATIVE", confidenceScore: 0.8, citationCount: 3, sampleQuotes: [] },
    ];
    expect(findIgnoredThemes(themes, ["Speed up the CSV export pipeline"]).map((t) => t.name)).toEqual(["Onboarding friction"]);
  });
});
