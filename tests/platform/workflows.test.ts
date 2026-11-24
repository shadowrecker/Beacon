import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { QUEUE } from "@/server/jobs/queues";
import { runJob } from "@/server/jobs/worker";
import { getOrgIntegrationCredentials } from "@/server/integrations/credentials";
import { createJiraIssue, createLinearIssue, IntegrationNotConnectedError, postSlackMessage } from "@/server/integrations/outbound";
import { workflowsSubscriber } from "@/server/events/subscribers/workflows";
import { workflowWorker } from "@/workers/workflow-worker";
import { evaluateConditions } from "@/server/workflows/conditions";
import { validateDefinition } from "@/server/workflows/service";
import { WORKFLOW_TEMPLATES } from "@/server/workflows/templates";
import { RUN_RATE_LIMIT } from "@/server/workflows/engine";
import { renderTemplate } from "@/server/workflows/render";
import { ACTION_TYPES, eventFields, placeholdersFor } from "@/server/workflows/definitions";
import { actionJsonSchema, defaultParams } from "@/components/workflows/action-params-form";
import { callerFor } from "../helpers/caller";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { connectIntegration, createRecommendation, createTenant, insertEvent, jobMeta, log, memberOf, type Tenant } from "./helpers";

vi.mock("@/server/integrations/outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/integrations/outbound")>();
  return { ...actual, createJiraIssue: vi.fn(), createLinearIssue: vi.fn(), postSlackMessage: vi.fn() };
});

const jira = vi.mocked(createJiraIssue);
const linear = vi.mocked(createLinearIssue);
const slack = vi.mocked(postSlackMessage);

let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  jira.mockReset();
  linear.mockReset();
  slack.mockReset();
  // The fake Jira resolves the credentials of whatever org it is called with, so the
  // returned key proves whose credentials were used.
  jira.mockImplementation(async (orgId) => {
    const integ = await getOrgIntegrationCredentials(orgId, "JIRA");
    if (!integ) throw new IntegrationNotConnectedError("JIRA");
    return { key: `${integ.credentials.siteSubdomain.toUpperCase()}-1`, url: `https://${integ.credentials.siteSubdomain}.atlassian.net/browse/X-1` };
  });
  slack.mockResolvedValue({ ts: "1.0", channel: "C1234567" });
  a = await createTenant("Acme");
  b = await createTenant("Globex");
  await connectIntegration(a, "JIRA", { email: "a@acme.test", apiToken: "acme-token", siteSubdomain: "acme" }, { projectKey: "ACME" });
  await connectIntegration(b, "JIRA", { email: "b@globex.test", apiToken: "globex-token", siteSubdomain: "globex" }, { projectKey: "GLOBEX" });
});

function baseWorkflow(projectId: string, actions: unknown[], trigger: unknown = { event: "recommendation.created", conditions: [] }) {
  return { projectId, name: "Test workflow", trigger, actions } as never;
}

async function createWorkflowRow(t: Tenant, actions: unknown[], trigger: unknown = { event: "recommendation.created", conditions: [] }) {
  return prisma.workflow.create({
    data: { projectId: t.projectId, orgId: t.orgId, name: "Direct", trigger: trigger as never, actions: actions as never, createdBy: t.owner.id },
  });
}

async function runFor(workflowId: string, eventId: string | null, attempt = 1, maxAttempts = 3, jobRunId?: string) {
  return runJob(workflowWorker, { workflowId, eventId, ...(jobRunId ? { jobRunId } : {}) }, jobMeta(attempt, maxAttempts));
}

describe("workflow definitions: confused-deputy params are rejected", () => {
  it.each([
    ["orgId on a Jira export", { type: "EXPORT_TO_JIRA", params: { orgId: "victim-org" } }],
    ["credentials on a Jira export", { type: "EXPORT_TO_JIRA", params: { credentials: { apiToken: "x" }, cloudId: "evil.example/x?" } }],
    ["a Linear API key", { type: "EXPORT_TO_LINEAR", params: { apiKey: "lin_123" } }],
    ["a Slack token", { type: "NOTIFY_SLACK", params: { message: "hi", botToken: "xoxb-1" } }],
    ["from and html on email", { type: "NOTIFY_EMAIL", params: { recipients: ["role:ADMIN"], subject: "s", message: "m", from: "ceo@victim.test", html: "<a href=x>" } }],
    ["raw email recipients", { type: "NOTIFY_EMAIL", params: { recipients: ["attacker@evil.test"], subject: "s", message: "m" } }],
    ["a roadmap orgId", { type: "ADD_TO_ROADMAP", params: { orgId: "victim-org" } }],
  ])("rejects %s", async (_label, action) => {
    await expect(callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [action]))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.workflow.count()).toBe(0);
  });

  it("rejects the removed `matches` (regex) operator", async () => {
    const trigger = { event: "theme.detected", conditions: [{ field: "name", operator: "matches", value: "(a+)+$" }] };
    await expect(
      callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "ALERT_TEAM", params: { title: "t", message: "m" } }], trigger))
    ).rejects.toThrow(/matches/);
  });

  it("rejects self-triggering trigger/action pairs", async () => {
    for (const event of ["SYNTHESIS_COMPLETED", "synthesis.completed", "THEME_DETECTED", "theme.detected"]) {
      await expect(
        callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "RUN_SYNTHESIS", params: {} }], { event, conditions: [] }))
      ).rejects.toThrow(/loop/);
    }
    // ... including on update of an existing workflow.
    const ok = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [{ type: "ALERT_TEAM", params: { title: "t", message: "m" } }], { event: "synthesis.completed", conditions: [] })
    );
    await expect(callerFor(a.owner).workflow.update({ id: ok.id, actions: [{ type: "RUN_SYNTHESIS", params: {} }] })).rejects.toThrow(/loop/);
  });

  it("rejects foreign IDs from another project or org", async () => {
    const foreignRec = await createRecommendation(b.projectId);
    await expect(
      callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "EXPORT_TO_JIRA", params: { recommendationId: foreignRec.id } }]))
    ).rejects.toThrow(/Recommendation not found/);
    await expect(
      callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "ASSIGN_USER", params: { userId: b.owner.id } }]))
    ).rejects.toThrow(/members of this workspace/);
  });

  it("requires a recommendation source for recommendation actions", async () => {
    await expect(
      callerFor(a.owner).workflow.create(
        baseWorkflow(a.projectId, [{ type: "EXPORT_TO_JIRA", params: {} }], { event: "synthesis.completed", conditions: [] })
      )
    ).rejects.toThrow(/needs a recommendation/);
  });

  it("stores the normalized domain event for legacy trigger names", async () => {
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [{ type: "CREATE_BRIEF", params: {} }], { event: "RECOMMENDATION_GENERATED", conditions: [] })
    );
    const row = await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id } });
    expect((row.trigger as { event: string }).event).toBe("recommendation.created");
    expect(row.orgId).toBe(a.orgId);
  });

  it("every built-in template is a valid definition", async () => {
    for (const t of WORKFLOW_TEMPLATES) {
      await expect(validateDefinition(prisma, { projectId: a.projectId, orgId: a.orgId }, t)).resolves.toBeTruthy();
    }
  });
});

describe("workflow router authorization", () => {
  it("lets VIEWERs read but not write, and hides workflows from outsiders", async () => {
    const viewer = await memberOf(a.orgId, "VIEWER");
    const action = { type: "ALERT_TEAM", params: { title: "t", message: "m" } };
    await expect(callerFor(viewer).workflow.create(baseWorkflow(a.projectId, [action]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const wf = await callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [action]));
    await expect(callerFor(viewer).workflow.get({ id: wf.id })).resolves.toMatchObject({ id: wf.id, canManage: false });
    await expect(callerFor(viewer).workflow.toggle({ id: wf.id, enabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(viewer).workflow.runManually({ id: wf.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(viewer).workflow.delete({ id: wf.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(b.owner).workflow.get({ id: wf.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(b.owner).workflow.runs({ workflowId: wf.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const listB = await callerFor(b.owner, b.orgId).workflow.list();
    expect(listB.items).toHaveLength(0);
    const listA = await callerFor(viewer, a.orgId).workflow.list();
    expect(listA.items.map((w) => w.id)).toEqual([wf.id]);
    expect(listA.canManage).toBe(false);
  });

  it("runManually enqueues a job tracked by a JobRun instead of running inline", async () => {
    const wf = await callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "NOTIFY_SLACK", params: { message: "manual" } }]));
    const { jobRunId } = await callerFor(a.owner).workflow.runManually({ id: wf.id });
    const job = await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } });
    expect(job).toMatchObject({ kind: "WORKFLOW_MANUAL_RUN", status: "PENDING", projectId: a.projectId });
    expect(slack).not.toHaveBeenCalled();
    const queued = jobsFor(QUEUE.WORKFLOWS);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ workflowId: wf.id, eventId: null, jobRunId });

    await runFor(wf.id, null, 1, 3, jobRunId);
    expect(slack).toHaveBeenCalledTimes(1);
    const done = await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } });
    expect(done.status).toBe("READY");
    const runId = (done.output as { runId: string }).runId;
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("SUCCESS");
    // A retried job resumes the same run instead of running again.
    await runFor(wf.id, null, 2, 3, jobRunId);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(1);
  });

  it("installs templates disabled and paginates runs", async () => {
    const templates = await callerFor(a.owner).workflow.listTemplates();
    expect(templates.length).toBe(WORKFLOW_TEMPLATES.length);
    const installed = await callerFor(a.owner).workflow.installTemplate({ templateId: "accepted-to-jira", projectId: a.projectId });
    const row = await prisma.workflow.findUniqueOrThrow({ where: { id: installed.id } });
    expect(row.enabled).toBe(false);
    await expect(callerFor(b.owner).workflow.installTemplate({ templateId: "accepted-to-jira", projectId: a.projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(a.owner).workflow.runs({ workflowId: installed.id, limit: 500 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("workflow execution", () => {
  it("EXPORT_TO_JIRA uses only the workflow project's org credentials", async () => {
    const rec = await createRecommendation(a.projectId);
    const wf = await callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "EXPORT_TO_JIRA", params: {} }]));
    const event = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", {
      recommendationId: rec.id,
      title: rec.title,
      impact: "HIGH",
      confidence: 0.9,
    });
    await runFor(wf.id, event.id);
    expect(jira).toHaveBeenCalledTimes(1);
    expect(jira.mock.calls[0][0]).toBe(a.orgId);
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(run.status).toBe("SUCCESS");
    const results = run.actionsExecuted as Array<{ output: { key: string } }>;
    expect(results[0].output.key).toBe("ACME-1");
  });

  it("re-validates stored params at run time, so smuggled orgId/credentials never reach an integration", async () => {
    const rec = await createRecommendation(a.projectId);
    const wf = await createWorkflowRow(a, [{ type: "EXPORT_TO_JIRA", params: { orgId: b.orgId, credentials: { apiToken: "x" } } }]);
    const event = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", {
      recommendationId: rec.id,
      title: rec.title,
      impact: "HIGH",
      confidence: 0.9,
    });
    await runFor(wf.id, event.id);
    expect(jira).not.toHaveBeenCalled();
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(run.status).toBe("FAILED");
  });

  it("rejects a recommendation from another project referenced by the event", async () => {
    const foreign = await createRecommendation(b.projectId, "Globex secret plan");
    const wf = await callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "EXPORT_TO_JIRA", params: {} }]));
    const event = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", {
      recommendationId: foreign.id,
      title: "x",
      impact: "HIGH",
      confidence: 0.9,
    });
    await runFor(wf.id, event.id);
    expect(jira).not.toHaveBeenCalled();
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(run.status).toBe("FAILED");
    expect((run.actionsExecuted as Array<{ message: string }>)[0].message).toMatch(/not found in this workflow's project/);
  });

  it("refuses to pair a workflow with another tenant's event", async () => {
    const wf = await callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "NOTIFY_SLACK", params: { message: "x" } }]));
    const foreignEvent = await insertEvent({ orgId: b.orgId, projectId: b.projectId }, "recommendation.created", {
      recommendationId: "r1",
      title: "x",
      impact: "HIGH",
      confidence: 0.9,
    });
    await expect(runFor(wf.id, foreignEvent.id)).rejects.toThrow();
    expect(slack).not.toHaveBeenCalled();
    expect(await prisma.workflowRun.count()).toBe(0);
  });

  it("marks a run PARTIAL_FAILURE when one action fails, FAILED when all do", async () => {
    const rec = await createRecommendation(a.projectId);
    const payload = { recommendationId: rec.id, title: rec.title, impact: "HIGH", confidence: 0.9 };
    // Linear is not connected for org A: that action fails permanently.
    linear.mockRejectedValue(new IntegrationNotConnectedError("LINEAR"));
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [
        { type: "NOTIFY_SLACK", params: { message: "New: {{title}}" } },
        { type: "EXPORT_TO_LINEAR", params: {} },
      ])
    );
    const e1 = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", payload);
    await runFor(wf.id, e1.id);
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id, eventId: e1.id } });
    expect(run.status).toBe("PARTIAL_FAILURE");
    const results = run.actionsExecuted as Array<{ status: string; message: string }>;
    expect(results.map((r) => r.status)).toEqual(["success", "failed"]);
    expect(results[1].message).toMatch(/LINEAR is not connected/);
    expect(run.error).toMatch(/1 of 2/);

    slack.mockRejectedValue(Object.assign(new Error("bad"), { status: 400 }));
    const e2 = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", payload);
    await runFor(wf.id, e2.id);
    const run2 = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id, eventId: e2.id } });
    expect(run2.status).toBe("FAILED");
    // Upstream bodies never reach the stored result.
    expect((run2.actionsExecuted as Array<{ message: string }>)[0].message).toBe("The provider returned status 400");
  });

  it("retries only transient failures and never repeats a succeeded side effect", async () => {
    const rec = await createRecommendation(a.projectId);
    jira.mockRejectedValueOnce(Object.assign(new Error("upstream"), { status: 503 }));
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [
        { type: "NOTIFY_SLACK", params: { message: "x" } },
        { type: "EXPORT_TO_JIRA", params: {} },
      ])
    );
    const e = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", {
      recommendationId: rec.id,
      title: rec.title,
      impact: "HIGH",
      confidence: 0.9,
    });
    await expect(runFor(wf.id, e.id, 1, 3)).rejects.toThrow(/temporary/);
    expect((await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id } })).status).toBe("RUNNING");
    await runFor(wf.id, e.id, 2, 3);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(jira).toHaveBeenCalledTimes(2);
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(run.status).toBe("SUCCESS");
    expect((await prisma.workflow.findUniqueOrThrow({ where: { id: wf.id } })).runCount).toBe(1);
  });

  it("a redelivered event never runs the workflow twice", async () => {
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [{ type: "NOTIFY_SLACK", params: { message: "done" } }], { event: "synthesis.completed", conditions: [] })
    );
    const e = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "synthesis.completed", { synthesisId: "s1", themeCount: 3 });
    await workflowsSubscriber.handle(e, log);
    await workflowsSubscriber.handle(e, log);
    expect(jobsFor(QUEUE.WORKFLOWS)).toHaveLength(1);
    await runFor(wf.id, e.id);
    await runFor(wf.id, e.id);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(await prisma.workflowRun.count({ where: { workflowId: wf.id } })).toBe(1);
  });

  it("escapes event text in Slack messages", async () => {
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [{ type: "NOTIFY_SLACK", params: { message: "Theme: {{name}}" } }], { event: "theme.detected", conditions: [] })
    );
    const e = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "theme.detected", {
      synthesisId: "s",
      themeId: "t",
      name: "<!channel> <https://evil.test|click here>",
      sentiment: "NEGATIVE",
      confidence: 0.9,
    });
    await runFor(wf.id, e.id);
    expect(slack.mock.calls[0][0]).toBe(a.orgId);
    expect(slack.mock.calls[0][1].text).toBe("Theme: &lt;!channel&gt; &lt;https://evil.test|click here&gt;");
  });

  it("CREATE_BRIEF generates and stores a brief with customer text marked untrusted, once", async () => {
    const rec = await createRecommendation(a.projectId);
    scriptLLM("recommendations.brief", () => ({
      title: "SSO",
      problemStatement: "Security reviews block enterprise deals without SSO.",
      userStories: [{ persona: "IT admin", action: "enforce SAML login", benefit: "pass security review", acceptanceCriteria: ["SAML works"] }],
      requirements: [{ id: "P0-1", priority: "P0", description: "SAML 2.0", acceptanceCriteria: ["Okta"] }],
      successMetrics: [{ metric: "Enterprise win rate", targetValue: "+10%", measuringMethod: "CRM" }],
      openQuestions: [],
      risks: ["IdP quirks"],
      impactedSegments: ["enterprise"],
      expectedImpact: "high",
    }));
    const wf = await callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "CREATE_BRIEF", params: {} }]));
    const payload = { recommendationId: rec.id, title: rec.title, impact: "HIGH", confidence: 0.9 };
    await runFor(wf.id, (await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", payload)).id);
    const updated = await prisma.recommendation.findUniqueOrThrow({ where: { id: rec.id } });
    expect((updated.brief as { problemStatement: string }).problemStatement).toMatch(/Security reviews/);
    expect(updated.briefGeneratedAt).not.toBeNull();
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].prompt).toContain("<untrusted_data");
    expect(llmCalls[0].prompt).toContain("security review");
    expect(llmCalls[0].system).toContain("untrusted_data");

    // A second trigger reuses the stored brief instead of paying for a new one.
    await runFor(wf.id, (await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", payload)).id);
    expect(llmCalls).toHaveLength(1);
    const second = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id }, orderBy: { startedAt: "desc" } });
    expect((second.actionsExecuted as Array<{ status: string }>)[0].status).toBe("skipped");
  });

  it("NOTIFY_EMAIL only reaches org members, never raw addresses", async () => {
    const admin = await memberOf(a.orgId, "ADMIN");
    const member = await memberOf(a.orgId, "MEMBER");
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(
        a.projectId,
        [{ type: "NOTIFY_EMAIL", params: { recipients: ["role:ADMIN"], subject: "Gap: {{gapCount}}", message: "See {{link}}" } }],
        { event: "gap.detected", conditions: [] }
      )
    );
    const e = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "gap.detected", { gapAnalysisId: "g", roadmapId: "r", gapCount: 4 });
    await runFor(wf.id, e.id);
    const notified = await prisma.notification.findMany({ select: { userId: true, title: true } });
    expect(notified.map((n) => n.userId).sort()).toEqual([a.owner.id, admin.id].sort());
    expect(notified[0].title).toBe("Gap: 4");
    const emails = jobsFor(QUEUE.EMAIL).map((j) => (j.payload as { to: string }).to).sort();
    expect(emails).toEqual([a.owner.email, admin.email].sort());
    expect(emails).not.toContain(member.email);
  });

  it("ADD_TO_ROADMAP writes only into the workflow project's roadmap, idempotently", async () => {
    const rec = await createRecommendation(a.projectId);
    const roadmap = await prisma.roadmap.create({ data: { projectId: a.projectId, name: "2026" } });
    const foreignRoadmap = await prisma.roadmap.create({ data: { projectId: b.projectId, name: "Globex" } });
    await expect(
      callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "ADD_TO_ROADMAP", params: { roadmapId: foreignRoadmap.id } }]))
    ).rejects.toThrow(/Roadmap not found/);
    const wf = await callerFor(a.owner).workflow.create(baseWorkflow(a.projectId, [{ type: "ADD_TO_ROADMAP", params: { roadmapId: roadmap.id, priority: "P1" } }]));
    const payload = { recommendationId: rec.id, title: rec.title, impact: "HIGH", confidence: 0.9 };
    await runFor(wf.id, (await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", payload)).id);
    await runFor(wf.id, (await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "recommendation.created", payload)).id);
    const items = await prisma.roadmapItem.findMany();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ roadmapId: roadmap.id, priority: "P1", title: rec.title });
  });

  it("RUN_SYNTHESIS creates a PENDING synthesis and enqueues it", async () => {
    await prisma.document.create({ data: { projectId: a.projectId, title: "d", type: "NOTE", status: "READY", processedText: "x" } });
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [{ type: "RUN_SYNTHESIS", params: { type: "THEMES" } }], { event: "document.ready", conditions: [] })
    );
    const e = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "document.ready", { documentId: "d", title: "d", chunkCount: 2 });
    await runFor(wf.id, e.id);
    const s = await prisma.synthesis.findFirstOrThrow({ where: { projectId: a.projectId } });
    expect(s).toMatchObject({ status: "PENDING", type: "THEMES" });
    expect(jobsFor(QUEUE.SYNTHESIS).map((j) => j.payload)).toEqual([{ synthesisId: s.id }]);
  });
});

describe("loop guards", () => {
  it("ignores events at or beyond the causation depth limit", async () => {
    await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [{ type: "NOTIFY_SLACK", params: { message: "x" } }], { event: "document.ready", conditions: [] })
    );
    const deep = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "document.ready", { documentId: "d", title: "t", chunkCount: 1 }, 3);
    await workflowsSubscriber.handle(deep, log);
    expect(jobsFor(QUEUE.WORKFLOWS)).toHaveLength(0);
    const shallow = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "document.ready", { documentId: "d", title: "t", chunkCount: 1 }, 2);
    await workflowsSubscriber.handle(shallow, log);
    expect(jobsFor(QUEUE.WORKFLOWS)).toHaveLength(1);
  });

  it("only triggers enabled workflows of the event's project whose conditions match", async () => {
    const mk = (conditions: unknown[], enabled = true) =>
      callerFor(a.owner).workflow.create({ ...(baseWorkflow(a.projectId, [{ type: "ALERT_TEAM", params: { title: "t", message: "m" } }], { event: "theme.detected", conditions }) as object), enabled } as never);
    const match = await mk([{ field: "sentiment", operator: "eq", value: "negative" }, { field: "confidence", operator: "gt", value: 0.5 }]);
    await mk([{ field: "confidence", operator: "lt", value: 0.5 }]);
    await mk([], false);
    await callerFor(b.owner).workflow.create(baseWorkflow(b.projectId, [{ type: "ALERT_TEAM", params: { title: "t", message: "m" } }], { event: "theme.detected", conditions: [] }));
    const e = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "theme.detected", { synthesisId: "s", themeId: "t", name: "n", sentiment: "NEGATIVE", confidence: 0.9 });
    await workflowsSubscriber.handle(e, log);
    expect(jobsFor(QUEUE.WORKFLOWS).map((j) => (j.payload as { workflowId: string }).workflowId)).toEqual([match.id]);
  });

  it("caps event-triggered runs per workflow per hour", async () => {
    const wf = await callerFor(a.owner).workflow.create(
      baseWorkflow(a.projectId, [{ type: "NOTIFY_SLACK", params: { message: "x" } }], { event: "document.ready", conditions: [] })
    );
    await getRedis().set(`rl:${RUN_RATE_LIMIT.name}:${wf.id}`, String(RUN_RATE_LIMIT.limit), "PX", 60_000);
    const e = await insertEvent({ orgId: a.orgId, projectId: a.projectId }, "document.ready", { documentId: "d", title: "t", chunkCount: 1 });
    await runFor(wf.id, e.id);
    expect(slack).not.toHaveBeenCalled();
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(run.status).toBe("FAILED");
    expect(run.error).toMatch(/times in the last hour/);
  });
});

describe("conditions and templates", () => {
  it("evaluates operators safely and fails closed on invalid or legacy conditions", () => {
    const payload = { title: "Checkout is slow", confidence: 0.8, tags: ["perf", "checkout"], nested: { a: 1 } };
    expect(evaluateConditions([{ field: "title", operator: "contains", value: "slow" }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "tags", operator: "contains", value: "perf" }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "confidence", operator: "gt", value: 0.5 }, { field: "confidence", operator: "lt", value: 0.9 }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "nested.a", operator: "eq", value: 1 }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "title", operator: "in", value: ["a", "Checkout is slow"] }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "missing", operator: "exists", value: false }], payload)).toBe(true);
    expect(evaluateConditions([{ field: "title", operator: "neq", value: "Checkout is slow" }], payload)).toBe(false);
    expect(evaluateConditions([{ field: "title", operator: "matches", value: "(a+)+$" }], payload)).toBe(false);
    expect(evaluateConditions([{ field: "__proto__.polluted", operator: "exists" }], payload)).toBe(false);
    expect(evaluateConditions([{ field: "constructor", operator: "exists" }], payload)).toBe(false);
    expect(evaluateConditions("garbage", payload)).toBe(false);
  });

  it("exposes event fields and generates every action form from its schema", () => {
    expect(eventFields("recommendation.created")).toEqual([
      { name: "recommendationId", type: "string" },
      { name: "title", type: "string" },
      { name: "impact", type: "string" },
      { name: "confidence", type: "number" },
    ]);
    expect(eventFields("voice.ready").map((f) => f.name)).toEqual(["recordingId", "documentId"]);
    expect(placeholdersFor("theme.detected")).toEqual(expect.arrayContaining(["event", "project", "link", "name", "confidence"]));
    for (const type of ACTION_TYPES) {
      const schema = actionJsonSchema(type);
      expect(Object.keys(schema.properties ?? {}).length, type).toBeGreaterThan(0);
      // No generated form ever offers tenant, credential, sender or markup fields.
      for (const forbidden of ["orgId", "credentials", "apiToken", "from", "html", "url", "cloudId"]) {
        expect(schema.properties ?? {}, `${type}.${forbidden}`).not.toHaveProperty(forbidden);
      }
    }
    expect(actionJsonSchema("NOTIFY_EMAIL").properties?.recipients.widget).toBe("recipients");
    expect(actionJsonSchema("ASSIGN_USER").properties?.userId.widget).toBe("member");
    expect(actionJsonSchema("NOTIFY_SLACK").properties?.message.widget).toBe("template");
    expect(defaultParams("ALERT_TEAM")).toEqual({ audience: "role:ADMIN", priority: "MEDIUM" });
  });

  it("renders unknown placeholders empty and flattens values", () => {
    expect(renderTemplate("{{title}} / {{nope}}", { title: "a\nb" }, "text")).toBe("a b / ");
  });
});
