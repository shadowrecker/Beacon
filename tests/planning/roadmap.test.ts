import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { safeFetch } from "@/lib/safe-fetch";
import { gapAnalysisWorker } from "@/workers/gap-analysis-worker";
import { importWorker } from "@/workers/import-worker";
import { productboardNextUrl } from "@/server/ai/roadmap/importer";
import { parseCsv } from "@/server/ai/roadmap/csv";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { callerFor, expectDone, expectQueued, fakeResponse, runWorker, seedIntegration, seedSynthesis, setupTeam } from "./helpers";

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: vi.fn() };
});
const mockedFetch = vi.mocked(safeFetch);

beforeEach(() => mockedFetch.mockReset());

function refFor(prompt: string, label: string): string {
  const m = prompt.match(new RegExp(`(T\\d+|R\\d+): (?:\\[[^\\]]*\\] )?${label}`));
  if (!m) throw new Error(`ref for ${label} not found in prompt`);
  return m[1];
}

async function seedRoadmap(projectId: string) {
  const roadmap = await prisma.roadmap.create({ data: { projectId, name: "2026 plan", metadata: { owner: "pm-team" } } });
  await prisma.roadmapItem.createMany({
    data: [
      { roadmapId: roadmap.id, title: "Async CSV exports", status: "IN_PROGRESS", priority: "P0", externalId: "a" },
      { roadmapId: roadmap.id, title: "Dark mode", status: "PLANNED", priority: "P2", externalId: "b" },
    ],
  });
  return roadmap;
}

function scriptGapAnalysis() {
  scriptLLM("roadmap.gap_analysis", (req) => {
    expect(req.system).toContain("untrusted_data");
    const exportsTheme = refFor(req.prompt, "CSV export times out");
    const ssoTheme = refFor(req.prompt, "SSO for enterprise");
    const exportsItem = refFor(req.prompt, "Async CSV exports");
    return {
      covered: [{ theme: exportsTheme, items: [exportsItem, "R99"], rationale: "Async exports address the timeouts." }],
      partial: [],
      missing: [
        { theme: ssoTheme, rationale: "Nothing on the roadmap covers SSO.", suggestedTitle: "SAML SSO", suggestedDescription: "Add SAML single sign-on." },
        { theme: "T77", rationale: "invented", suggestedTitle: "x", suggestedDescription: "y" },
      ],
      recommendations: [{ title: "Add SSO", description: "Plan SSO for Q3.", themes: [ssoTheme, "T42"], priority: "P0" }],
      summary: "Exports are covered; SSO is missing.",
    };
  });
}

describe("roadmap authorization", () => {
  it("hides roadmaps from outsiders and blocks viewer writes", async () => {
    const { owner, viewer, outsider, project } = await setupTeam();
    const roadmap = await seedRoadmap(project.id);

    await expect(callerFor(outsider).roadmap.list({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).roadmap.get({ projectId: project.id, roadmapId: roadmap.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).roadmap.getGapAnalysis({ projectId: project.id, roadmapId: roadmap.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const viewerCaller = callerFor(viewer);
    await expect(viewerCaller.roadmap.list({ projectId: project.id })).resolves.toMatchObject({ items: [expect.objectContaining({ id: roadmap.id, itemCount: 2 })] });
    await expect(viewerCaller.roadmap.create({ projectId: project.id, name: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewerCaller.roadmap.addItem({ projectId: project.id, roadmapId: roadmap.id, title: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewerCaller.roadmap.import({ projectId: project.id, source: "CSV", csv: "title\nA" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewerCaller.roadmap.runGapAnalysis({ projectId: project.id, roadmapId: roadmap.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const item = await prisma.roadmapItem.findFirstOrThrow({ where: { roadmapId: roadmap.id } });
    await expect(viewerCaller.roadmap.updateItem({ projectId: project.id, itemId: item.id, title: "y" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(owner).roadmap.updateItem({ projectId: project.id, itemId: item.id, status: "COMPLETED" })).resolves.toMatchObject({ status: "COMPLETED" });
  });

  it("rejects items and roadmaps that belong to another project", async () => {
    const { owner, outsider, project, outsiderProject } = await setupTeam();
    const foreignRoadmap = await seedRoadmap(outsiderProject.id);
    const foreignItem = await prisma.roadmapItem.findFirstOrThrow({ where: { roadmapId: foreignRoadmap.id } });
    const caller = callerFor(owner);

    await expect(caller.roadmap.get({ projectId: project.id, roadmapId: foreignRoadmap.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.roadmap.addItem({ projectId: project.id, roadmapId: foreignRoadmap.id, title: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.roadmap.updateItem({ projectId: project.id, itemId: foreignItem.id, title: "pwned" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.roadmap.deleteItem({ projectId: project.id, itemId: foreignItem.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.roadmap.import({ projectId: project.id, roadmapId: foreignRoadmap.id, source: "CSV", csv: "title\nA" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.roadmapItem.findUniqueOrThrow({ where: { id: foreignItem.id } })).title).toBe("Async CSV exports");
    void outsider;
  });
});

describe("runGapAnalysis", () => {
  it("rejects a roadmap from another project or org and creates no analysis", async () => {
    const { owner, project, org } = await setupTeam();
    await seedSynthesis(project.id, [{ name: "CSV export times out" }]);
    const sameOrgProject = await prisma.project.create({ data: { name: "Sibling", userId: owner.id, orgId: org.id } });
    const siblingRoadmap = await seedRoadmap(sameOrgProject.id);
    const victim = await setupTeam();
    const victimRoadmap = await seedRoadmap(victim.project.id);

    const caller = callerFor(owner);
    await expect(caller.roadmap.runGapAnalysis({ projectId: project.id, roadmapId: siblingRoadmap.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.roadmap.runGapAnalysis({ projectId: project.id, roadmapId: victimRoadmap.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.gapAnalysis.count()).toBe(0);
    expect(jobsFor(QUEUE.GAP_ANALYSIS)).toHaveLength(0);
  });

  it("requires themes and roadmap items", async () => {
    const { owner, project } = await setupTeam();
    const empty = await prisma.roadmap.create({ data: { projectId: project.id, name: "Empty" } });
    await expect(callerFor(owner).roadmap.runGapAnalysis({ projectId: project.id, roadmapId: empty.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const roadmap = await seedRoadmap(project.id);
    await expect(callerFor(owner).roadmap.runGapAnalysis({ projectId: project.id, roadmapId: roadmap.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("synthesis"),
    });
  });
});

describe("gap analysis worker", () => {
  it("updates the producer row to READY with validated references, without a second row", async () => {
    const { member, project } = await setupTeam();
    const { themes } = await seedSynthesis(project.id, [
      { name: "CSV export times out", mentions: [{ date: "2026-10-01", quote: "Exports time out every Monday" }] },
      { name: "SSO for enterprise", mentions: [{ date: "2026-10-02", quote: "We need SAML" }, { date: "2026-10-03", quote: "No SSO is a blocker" }] },
    ]);
    const roadmap = await seedRoadmap(project.id);
    const caller = callerFor(member);
    const started = await caller.roadmap.runGapAnalysis({ projectId: project.id, roadmapId: roadmap.id });
    expect(started.alreadyRunning).toBe(false);
    // A second click while it is running returns the same analysis.
    await expect(caller.roadmap.runGapAnalysis({ projectId: project.id, roadmapId: roadmap.id })).resolves.toMatchObject({
      gapAnalysisId: started.gapAnalysisId,
      alreadyRunning: true,
    });
    const job = jobsFor(QUEUE.GAP_ANALYSIS);
    expect(job).toHaveLength(1);
    expect(job[0].payload).toEqual({ gapAnalysisId: started.gapAnalysisId });

    scriptGapAnalysis();
    await runWorker(gapAnalysisWorker, job[0].payload);

    const rows = await prisma.gapAnalysis.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: started.gapAnalysisId, status: "READY", errorMessage: null });
    expect(rows[0].completedAt).toBeInstanceOf(Date);

    const result = await caller.roadmap.getGapAnalysis({ projectId: project.id, roadmapId: roadmap.id });
    const out = result.latest!.output!;
    const items = await prisma.roadmapItem.findMany({ where: { roadmapId: roadmap.id } });
    expect(out.covered).toHaveLength(1);
    expect(out.covered[0].themeId).toBe(themes[0].id);
    expect(out.covered[0].roadmapItems.map((i) => i.id)).toEqual([items.find((i) => i.title === "Async CSV exports")!.id]);
    expect(out.missing.map((m) => m.themeId)).toEqual([themes[1].id]);
    expect(out.missing[0].evidenceCount).toBe(2);
    expect(out.recommendations[0].themeIds).toEqual([themes[1].id]);
    // R99, T77 and T42 were invented by the model and dropped.
    expect(out.skipped.invalidReferences).toBe(3);
    expect(llmCalls).toHaveLength(1);

    const events = await prisma.domainEvent.findMany({ where: { type: "gap.detected" } });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ gapAnalysisId: started.gapAnalysisId, roadmapId: roadmap.id, gapCount: 1 });

    // Duplicate delivery: no new row, no new event, no new LLM call.
    await runWorker(gapAnalysisWorker, job[0].payload);
    expect(await prisma.gapAnalysis.count()).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: "gap.detected" } })).toBe(1);
    expect(llmCalls).toHaveLength(1);
  });

  it("marks the analysis FAILED without touching roadmap metadata", async () => {
    const { owner, project } = await setupTeam();
    await seedSynthesis(project.id, [{ name: "CSV export times out" }]);
    const roadmap = await seedRoadmap(project.id);
    const { gapAnalysisId } = await callerFor(owner).roadmap.runGapAnalysis({ projectId: project.id, roadmapId: roadmap.id });

    scriptLLM("roadmap.gap_analysis", () => ({ covered: "not an array" }));
    await expect(runWorker(gapAnalysisWorker, { gapAnalysisId })).rejects.toThrow();

    const row = await prisma.gapAnalysis.findUniqueOrThrow({ where: { id: gapAnalysisId } });
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBeTruthy();
    const after = await prisma.roadmap.findUniqueOrThrow({ where: { id: roadmap.id } });
    expect(after.metadata).toEqual({ owner: "pm-team" });
    const view = await callerFor(owner).roadmap.getGapAnalysis({ projectId: project.id, roadmapId: roadmap.id });
    expect(view.latest).toMatchObject({ status: "FAILED", output: null });
  });

  it("retries transient failures without failing the row until the last attempt", async () => {
    const { owner, project } = await setupTeam();
    await seedSynthesis(project.id, [{ name: "CSV export times out" }]);
    const roadmap = await seedRoadmap(project.id);
    const { gapAnalysisId } = await callerFor(owner).roadmap.runGapAnalysis({ projectId: project.id, roadmapId: roadmap.id });
    scriptLLM("roadmap.gap_analysis", () => {
      throw new Error("upstream overloaded");
    });
    await expect(runWorker(gapAnalysisWorker, { gapAnalysisId }, 1, 3)).rejects.toThrow("upstream overloaded");
    expect((await prisma.gapAnalysis.findUniqueOrThrow({ where: { id: gapAnalysisId } })).status).toBe("PROCESSING");
    await expect(runWorker(gapAnalysisWorker, { gapAnalysisId }, 3, 3)).rejects.toThrow();
    expect((await prisma.gapAnalysis.findUniqueOrThrow({ where: { id: gapAnalysisId } })).status).toBe("FAILED");
  });
});

describe("roadmap import", () => {
  it("parses quoted CSV fields", () => {
    const { header, rows } = parseCsv('title,description\r\n"Exports, async","Line one\nline ""two"""\r\nPlain,x\r\n', { maxRows: 10 });
    expect(header).toEqual(["title", "description"]);
    expect(rows).toEqual([
      ["Exports, async", 'Line one\nline "two"'],
      ["Plain", "x"],
    ]);
    expect(() => parseCsv('title\n"unterminated', { maxRows: 10 })).toThrow(/unterminated/);
    expect(parseCsv("title\na\nb\nc", { maxRows: 2 })).toMatchObject({ rows: [["a"], ["b"]], truncated: true });
  });

  it("upserts CSV items idempotently on (roadmapId, externalId) and stores source CSV", async () => {
    const { owner, project } = await setupTeam();
    const caller = callerFor(owner);
    const csv = [
      "Title,Description,Status,Priority,Quarter,External ID",
      '"Async exports, phase 1","Move exports to a job",in progress,P0,Q3,EXP-1',
      "Dark mode,,planned,low,Q4,",
      ",missing title,,,,",
    ].join("\n");
    const first = expectDone(await caller.roadmap.import({ projectId: project.id, source: "CSV", csv, name: "CSV plan", filename: "plan.csv" }));
    expect(first).toMatchObject({ mode: "done", source: "CSV", roadmapName: "CSV plan", created: 2, updated: 0, skippedCount: 1 });
    const second = expectDone(await caller.roadmap.import({ projectId: project.id, source: "CSV", roadmapId: first.roadmapId, csv }));
    expect(second).toMatchObject({ roadmapId: first.roadmapId, created: 0, updated: 2 });
    expect(jobsFor(QUEUE.IMPORTS)).toHaveLength(0); // CSV never goes through the queue

    const items = await prisma.roadmapItem.findMany({ where: { roadmapId: first.roadmapId }, orderBy: { title: "asc" } });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Async exports, phase 1", status: "IN_PROGRESS", priority: "P0", quarter: "Q3", externalId: "EXP-1" });
    expect(items[1]).toMatchObject({ title: "Dark mode", priority: "P3", externalId: expect.stringMatching(/^csv:/) });
    const roadmap = await prisma.roadmap.findUniqueOrThrow({ where: { id: first.roadmapId } });
    expect(roadmap.source).toBe("CSV");
    expect(roadmap.importedAt).toBeInstanceOf(Date);
    expect(roadmap.metadata).toMatchObject({ importOptions: { filename: "plan.csv" }, lastImport: { source: "CSV", created: 0, updated: 2, skipped: 1 } });
    expect(roadmap.metadata).not.toHaveProperty("importSource");
    const view = await caller.roadmap.get({ projectId: project.id, roadmapId: first.roadmapId });
    expect(view.roadmap).toMatchObject({ source: "CSV", importSource: null, lastImport: expect.objectContaining({ updated: 2 }) });

    await expect(caller.roadmap.import({ projectId: project.id, source: "CSV", csv: "description\nno title column" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("queues Linear imports and the worker imports with the project's org credentials, idempotently", async () => {
    const { owner, org, project } = await setupTeam();
    await seedIntegration(org.id, owner.id, "LINEAR", { apiKey: "lin_api_org" }, { teamId: "team-1" });
    // Another org's Linear integration must never be used.
    const other = await setupTeam();
    await seedIntegration(other.org.id, other.owner.id, "LINEAR", { apiKey: "lin_api_other" }, { teamId: "team-x" });

    const caller = callerFor(owner);
    const queued = expectQueued(await caller.roadmap.import({ projectId: project.id, source: "LINEAR", name: "Linear plan" }));
    expect(queued).toMatchObject({ status: "PENDING", alreadyRunning: false });
    expect(mockedFetch).not.toHaveBeenCalled(); // nothing fetched in the request
    await expect(caller.roadmap.import({ projectId: project.id, source: "LINEAR" })).resolves.toMatchObject({ mode: "queued", jobRunId: queued.jobRunId, alreadyRunning: true });
    const jobs = jobsFor(QUEUE.IMPORTS);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ payload: { jobRunId: queued.jobRunId }, opts: { jobId: `import_${queued.jobRunId}` } });
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } })).toMatchObject({
      kind: "ROADMAP_IMPORT",
      orgId: org.id,
      projectId: project.id,
      createdById: owner.id,
      input: { source: "LINEAR", roadmapId: null, name: "Linear plan", teamId: null },
    });

    const linearPage = () =>
      fakeResponse({
        data: {
          issues: {
            nodes: [
              { id: "iss-1", title: "Bulk export", description: "d", priority: 1, state: { name: "In Progress", type: "started" }, cycle: { name: "Cycle 12" } },
              { id: "iss-2", title: "Old thing", priority: 4, state: { name: "Canceled", type: "canceled" } },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    mockedFetch.mockResolvedValueOnce(linearPage());
    await runWorker(importWorker, jobs[0].payload);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockedFetch.mock.calls[0];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(opts?.headers).toMatchObject({ authorization: "lin_api_org" });
    expect(JSON.parse(String(opts?.body)).variables.teamId).toBe("team-1");

    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } });
    expect(run.status).toBe("READY");
    const output = run.output as { roadmapId: string; created: number; updated: number; source: string };
    expect(output).toMatchObject({ kind: "ROADMAP_IMPORT", source: "LINEAR", created: 2, updated: 0 });
    const items = await prisma.roadmapItem.findMany({ where: { roadmapId: output.roadmapId }, orderBy: { externalId: "asc" } });
    expect(items.map((i) => [i.externalId, i.status, i.priority])).toEqual([
      ["iss-1", "IN_PROGRESS", "P0"],
      ["iss-2", "CANCELLED", "P3"],
    ]);
    expect(await prisma.roadmap.findUniqueOrThrow({ where: { id: output.roadmapId } })).toMatchObject({ source: "LINEAR", name: "Linear plan" });
    expect(await caller.job.get({ id: run.id })).toMatchObject({ status: "READY" });

    // Duplicate delivery after completion does nothing.
    await runWorker(importWorker, jobs[0].payload);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // A retry after a crash between the upsert and READY reuses the roadmap the
    // first attempt created and updates the same items.
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: "PROCESSING", output: { phase: "importing", roadmapId: output.roadmapId } } });
    mockedFetch.mockResolvedValueOnce(linearPage());
    await runWorker(importWorker, jobs[0].payload, 2, 3);
    expect(await prisma.roadmap.count({ where: { projectId: project.id } })).toBe(1);
    expect(await prisma.roadmapItem.count({ where: { roadmapId: output.roadmapId } })).toBe(2);
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } })).output).toMatchObject({ roadmapId: output.roadmapId, created: 0, updated: 2 });
  });

  it("requires a connected integration and fails rejected credentials with a safe message", async () => {
    const { owner, org, project } = await setupTeam();
    await expect(callerFor(owner).roadmap.import({ projectId: project.id, source: "JIRA", projectKey: "PROD" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("not connected"),
    });
    expect(await prisma.jobRun.count()).toBe(0);

    await seedIntegration(org.id, owner.id, "JIRA", { email: "a@b.co", apiToken: "t", siteSubdomain: "acme" });
    const queued = expectQueued(await callerFor(owner).roadmap.import({ projectId: project.id, source: "JIRA", projectKey: "prod" }));
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } })).input).toMatchObject({ projectKey: "PROD" });
    mockedFetch.mockResolvedValueOnce(fakeResponse({ errorMessages: ["internal secret detail"] }, 401));
    await expect(runWorker(importWorker, { jobRunId: queued.jobRunId })).rejects.toThrow();

    expect(String(mockedFetch.mock.calls[0][0])).toMatch(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/search\/jql\?/);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } });
    expect(run.status).toBe("FAILED");
    expect(run.errorMessage).toBe("Jira rejected the stored credentials. Reconnect the integration and try again.");
    expect(await prisma.roadmap.count()).toBe(0); // nothing created when the fetch fails
  });

  it("fails transient upstream errors only on the last attempt, with a generic message", async () => {
    const { owner, org, project } = await setupTeam();
    await seedIntegration(org.id, owner.id, "NOTION", { apiKey: "secret_notion" });
    const queued = expectQueued(
      await callerFor(owner).roadmap.import({ projectId: project.id, source: "NOTION", databaseId: "0123456789abcdef0123456789abcdef" })
    );
    mockedFetch.mockResolvedValue(fakeResponse("<html>stack trace</html>", 502));
    await expect(runWorker(importWorker, { jobRunId: queued.jobRunId }, 1, 3)).rejects.toThrow();
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } })).status).toBe("PROCESSING");
    await expect(runWorker(importWorker, { jobRunId: queued.jobRunId }, 3, 3)).rejects.toThrow();
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } });
    expect(run).toMatchObject({ status: "FAILED", errorMessage: "Notion returned an error (502). Please try again." });
    expect(String(mockedFetch.mock.calls[0][0])).toBe("https://api.notion.com/v1/databases/0123456789abcdef0123456789abcdef/query");
  });

  it("re-verifies the run's project, roadmap and integration in the worker", async () => {
    const { owner, org, project } = await setupTeam();
    const other = await setupTeam();
    await seedIntegration(org.id, owner.id, "PRODUCTBOARD", { apiToken: "pb_token_0123456789abcdef" });
    // A run whose project is in a different org than the run's org is refused.
    const forged = await prisma.jobRun.create({
      data: { kind: "ROADMAP_IMPORT", orgId: org.id, projectId: other.project.id, status: "PENDING", input: { source: "PRODUCTBOARD", roadmapId: null, name: null } },
    });
    await expect(runWorker(importWorker, { jobRunId: forged.id })).rejects.toThrow();
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: forged.id } })).toMatchObject({ status: "FAILED" });
    // A target roadmap from another project is refused.
    const foreignRoadmap = await prisma.roadmap.create({ data: { projectId: other.project.id, name: "Theirs" } });
    const wrongRoadmap = await prisma.jobRun.create({
      data: { kind: "ROADMAP_IMPORT", orgId: org.id, projectId: project.id, status: "PENDING", input: { source: "PRODUCTBOARD", roadmapId: foreignRoadmap.id, name: null } },
    });
    await expect(runWorker(importWorker, { jobRunId: wrongRoadmap.id })).rejects.toThrow();
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: wrongRoadmap.id } })).toMatchObject({
      status: "FAILED",
      errorMessage: "The roadmap to import into no longer exists",
    });
    // An integration disconnected after the job was queued.
    const queued = expectQueued(await callerFor(owner).roadmap.import({ projectId: project.id, source: "PRODUCTBOARD" }));
    await prisma.integration.updateMany({ where: { orgId: org.id, provider: "PRODUCTBOARD" }, data: { status: "DISCONNECTED" } });
    await expect(runWorker(importWorker, { jobRunId: queued.jobRunId })).rejects.toThrow();
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } })).errorMessage).toContain("Productboard is not connected");
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(await prisma.roadmapItem.count()).toBe(0);
  });
});

describe("Productboard import", () => {
  const feature = (i: number, extra: Record<string, unknown> = {}) => ({
    id: `feat-${i}`,
    name: `Feature ${i}`,
    description: `<p>Customers <b>need</b> feature ${i} &amp; more</p>`,
    status: { name: "In progress" },
    timeframe: { startDate: "2026-08-01", endDate: "2026-09-30", granularity: "quarter" },
    ...extra,
  });

  it("maps features, follows next links on the API host and imports idempotently", async () => {
    const { owner, org, project } = await setupTeam();
    await seedIntegration(org.id, owner.id, "PRODUCTBOARD", { accessToken: "pb_access_0123456789abcdef" });
    mockedFetch
      .mockResolvedValueOnce(
        fakeResponse({
          data: [feature(1), feature(2, { status: { name: "Released" }, timeframe: { startDate: "none" } }), feature(3, { archived: true })],
          links: { next: "https://api.productboard.com/features?pageCursor=abc" },
        })
      )
      .mockResolvedValueOnce(fakeResponse({ data: [feature(4, { status: { name: "Won't do" }, description: null })], links: { next: null } }));

    const queued = expectQueued(await callerFor(owner).roadmap.import({ projectId: project.id, source: "PRODUCTBOARD" }));
    await runWorker(importWorker, { jobRunId: queued.jobRunId });

    expect(mockedFetch.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://api.productboard.com/features?pageLimit=100",
      "https://api.productboard.com/features?pageCursor=abc",
    ]);
    expect(mockedFetch.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer pb_access_0123456789abcdef", "x-version": "1" });

    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } });
    const out = run.output as { roadmapId: string };
    expect(run.output).toMatchObject({ source: "PRODUCTBOARD", created: 3, updated: 0, skippedCount: 1 });
    expect(await prisma.roadmap.findUniqueOrThrow({ where: { id: out.roadmapId } })).toMatchObject({ source: "PRODUCTBOARD" });
    const items = await prisma.roadmapItem.findMany({ where: { roadmapId: out.roadmapId }, orderBy: { externalId: "asc" } });
    expect(items.map((i) => ({ externalId: i.externalId, title: i.title, status: i.status, quarter: i.quarter, description: i.description }))).toEqual([
      { externalId: "feat-1", title: "Feature 1", status: "IN_PROGRESS", quarter: "Q3 2026", description: "Customers need feature 1 & more" },
      { externalId: "feat-2", title: "Feature 2", status: "COMPLETED", quarter: null, description: "Customers need feature 2 & more" },
      { externalId: "feat-4", title: "Feature 4", status: "CANCELLED", quarter: "Q3 2026", description: null },
    ]);

    // Importing again into the same roadmap updates the same rows.
    mockedFetch.mockResolvedValueOnce(fakeResponse({ data: [feature(1, { name: "Feature 1 renamed" })], links: {} }));
    const again = expectQueued(await callerFor(owner).roadmap.import({ projectId: project.id, source: "PRODUCTBOARD", roadmapId: out.roadmapId }));
    await runWorker(importWorker, { jobRunId: again.jobRunId });
    expect(await prisma.roadmapItem.count({ where: { roadmapId: out.roadmapId } })).toBe(3);
    expect((await prisma.roadmapItem.findFirstOrThrow({ where: { roadmapId: out.roadmapId, externalId: "feat-1" } })).title).toBe("Feature 1 renamed");
  });

  it("refuses pagination links that leave the Productboard API host", async () => {
    const { owner, org, project } = await setupTeam();
    await seedIntegration(org.id, owner.id, "PRODUCTBOARD", { apiToken: "pb_token_0123456789abcdef" });
    mockedFetch.mockResolvedValueOnce(fakeResponse({ data: [feature(1)], links: { next: "https://evil.example.com/features?steal=1" } }));
    const queued = expectQueued(await callerFor(owner).roadmap.import({ projectId: project.id, source: "PRODUCTBOARD" }));
    await expect(runWorker(importWorker, { jobRunId: queued.jobRunId })).rejects.toThrow();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } })).toMatchObject({
      status: "FAILED",
      errorMessage: "Productboard returned an unexpected pagination link",
    });
    expect(productboardNextUrl("/features?pageCursor=x")).toBe("https://api.productboard.com/features?pageCursor=x");
    expect(() => productboardNextUrl("http://api.productboard.com/features")).toThrow();
    expect(() => productboardNextUrl("https://user:pw@api.productboard.com/features")).toThrow();
    expect(productboardNextUrl(null)).toBeNull();
  });

  it("caps an import at 500 features", async () => {
    const { owner, org, project } = await setupTeam();
    await seedIntegration(org.id, owner.id, "PRODUCTBOARD", { apiToken: "pb_token_0123456789abcdef" });
    let page = 0;
    mockedFetch.mockImplementation(async () => {
      const start = page * 100;
      page++;
      return fakeResponse({
        data: Array.from({ length: 100 }, (_, i) => feature(start + i)),
        links: { next: `https://api.productboard.com/features?pageCursor=p${page}` },
      });
    });
    const queued = expectQueued(await callerFor(owner).roadmap.import({ projectId: project.id, source: "PRODUCTBOARD" }));
    await runWorker(importWorker, { jobRunId: queued.jobRunId });
    expect(mockedFetch).toHaveBeenCalledTimes(5);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } });
    expect(run.output).toMatchObject({ created: 500, truncated: true });
  });

  it("enforces authorization for Productboard imports", async () => {
    const { viewer, outsider, project } = await setupTeam();
    await expect(callerFor(viewer).roadmap.import({ projectId: project.id, source: "PRODUCTBOARD" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(outsider).roadmap.import({ projectId: project.id, source: "PRODUCTBOARD" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.jobRun.count()).toBe(0);
  });
});
