import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { safeFetch } from "@/lib/safe-fetch";
import { correlationWorker } from "@/workers/correlation-worker";
import { importWorker } from "@/workers/import-worker";
import { pearson, bucketOf, chooseUnit } from "@/server/ai/analytics/correlator";
import { validateRange } from "@/server/ai/analytics/importer";
import { jobsFor, scriptLLM } from "../helpers/doubles";
import { callerFor, days, expectDone, expectQueued, fakeResponse, runWorker, seedIntegration, seedSynthesis, setupTeam } from "./helpers";

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: vi.fn() };
});
const mockedFetch = vi.mocked(safeFetch);
beforeEach(() => mockedFetch.mockReset());

const DATES = days("2026-10-01", 8);
const PATTERN = [1, 3, 1, 3, 1, 3, 1, 3];

function metricsCsv(): string {
  const rows = ["feature,metric,value,date"];
  DATES.forEach((d, i) => {
    rows.push(`CSV export,export_failures,${PATTERN[i] * 10},${d}`);
    rows.push(`Dashboard,sessions,${(4 - PATTERN[i]) * 10},${d}`);
    rows.push(`Settings,visits,${i === 2 || i === 5 ? 6 : 5},${d}`);
  });
  return rows.join("\n");
}

async function seedCorrelationProject() {
  const team = await setupTeam();
  const mentions = DATES.flatMap((d, i) => Array.from({ length: PATTERN[i] }, (_, k) => ({ date: d, quote: `Export failed again (${d} #${k})` })));
  const { themes } = await seedSynthesis(team.project.id, [
    { name: "CSV export failures", mentions },
    { name: "SSO requests", mentions: [{ date: DATES[0], quote: "We need SSO" }] },
  ]);
  expectDone(await callerFor(team.owner).analytics.importData({ projectId: team.project.id, source: "CSV", csv: metricsCsv() }));
  return { ...team, themes };
}

describe("correlation statistics", () => {
  it("computes Pearson r and buckets dates", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(bucketOf("2026-10-08", "week")).toBe("2026-10-05"); // Monday
    expect(chooseUnit(["2026-01-01", "2026-01-20"])).toBe("day");
    expect(chooseUnit(["2026-01-01", "2026-03-20"])).toBe("week");
  });

  it("bounds import date ranges", () => {
    const now = new Date("2026-11-24T10:00:00Z");
    expect(validateRange({ start: "2026-10-01", end: "2026-10-31" }, now)).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(() => validateRange({ start: "2026-01-01", end: "2026-10-31" }, now)).toThrow(/at most 90 days/);
    expect(() => validateRange({ start: "2026-11-01", end: "2026-12-01" }, now)).toThrow(/future/);
    expect(() => validateRange({ start: "2026-10-31", end: "2026-10-01" }, now)).toThrow(/before/);
  });
});

describe("analytics authorization", () => {
  it("hides imports from outsiders and blocks viewer writes", async () => {
    const { owner, viewer, outsider, project } = await setupTeam();
    const imp = expectDone(await callerFor(owner).analytics.importData({ projectId: project.id, source: "CSV", csv: "feature,metric,value,date\nA,m,1,2026-10-01" }));

    await expect(callerFor(outsider).analytics.getImports({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).analytics.getCorrelations({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).analytics.listThemes({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).analytics.listSources({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(viewer).analytics.listThemes({ projectId: project.id })).resolves.toEqual([]);
    await expect(callerFor(outsider).analytics.deleteImport({ projectId: project.id, importId: imp.import.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(callerFor(viewer).analytics.getImports({ projectId: project.id })).resolves.toMatchObject({ items: [expect.objectContaining({ id: imp.import.id })] });
    await expect(callerFor(viewer).analytics.importData({ projectId: project.id, source: "CSV", csv: "feature,metric,value,date\nA,m,1,2026-10-01" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(viewer).analytics.runCorrelation({ projectId: project.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(viewer).analytics.deleteImport({ projectId: project.id, importId: imp.import.id })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Imports from another project can't be deleted through this project.
    const other = expectDone(await callerFor(outsider).analytics.importData({ projectId: (await prisma.project.findFirstOrThrow({ where: { userId: outsider.id } })).id, source: "CSV", csv: "feature,metric,value,date\nB,m,1,2026-10-01" }));
    await expect(callerFor(owner).analytics.deleteImport({ projectId: project.id, importId: other.import.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("analytics imports", () => {
  it("imports CSV metric rows with a summary and lists series", async () => {
    const { owner, project } = await setupTeam();
    const caller = callerFor(owner);
    const res = expectDone(await caller.analytics.importData({
      projectId: project.id,
      source: "CSV",
      csv: 'feature,metric,value,date,segment\n"Export, bulk",uses,"1,200",2026-10-01,\nExport,uses,abc,2026-10-02,\nExport,uses,5,not-a-date,\nExport,uses,7,2026-10-03,enterprise',
    }));
    expect(jobsFor(QUEUE.IMPORTS)).toHaveLength(0); // CSV never goes through the queue
    expect(res.summary).toMatchObject({ points: 2, series: 2, start: "2026-10-01", end: "2026-10-03", skipped: 2 });
    expect(res.skipped.map((s) => s.reason)).toEqual(["value is not a number", "invalid date"]);

    const list = await caller.analytics.getImports({ projectId: project.id, limit: 1 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ source: "CSV", summary: expect.objectContaining({ points: 2 }) });
    expect(list.items[0]).not.toHaveProperty("data");

    const series = await caller.analytics.listSeries({ projectId: project.id });
    expect(series.map((s) => `${s.feature}/${s.metric}`).sort()).toEqual(["Export, bulk/uses", "Export/uses · enterprise"]);
    const one = await caller.analytics.getSeries({ projectId: project.id, feature: "Export, bulk", metric: "uses" });
    expect(one.points).toEqual([{ date: "2026-10-01", value: 1200 }]);

    await expect(caller.analytics.importData({ projectId: project.id, source: "CSV", csv: "feature,value\nA,1" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("metric"),
    });
  });

  it("rejects an integrationId that belongs to another org", async () => {
    const { owner, project } = await setupTeam();
    const other = await setupTeam();
    const foreign = await seedIntegration(other.org.id, other.owner.id, "AMPLITUDE", { apiKey: "k", secretKey: "s" });
    await expect(
      callerFor(owner).analytics.importData({ projectId: project.id, source: "AMPLITUDE", integrationId: foreign.id, startDate: "2026-10-01", endDate: "2026-10-10" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(await prisma.analyticsImport.count()).toBe(0);
  });

  it("queues Amplitude imports; the worker uses the org's own credentials from a fixed host", async () => {
    const { owner, org, project } = await setupTeam();
    const integ = await seedIntegration(org.id, owner.id, "AMPLITUDE", { apiKey: "amp-key", secretKey: "amp-secret" });
    const caller = callerFor(owner);

    const queued = expectQueued(
      await caller.analytics.importData({ projectId: project.id, source: "AMPLITUDE", integrationId: integ.id, startDate: "2026-10-01", endDate: "2026-10-03" })
    );
    expect(mockedFetch).not.toHaveBeenCalled(); // nothing fetched in the request
    await expect(
      caller.analytics.importData({ projectId: project.id, source: "AMPLITUDE", startDate: "2026-10-01", endDate: "2026-10-03" })
    ).resolves.toMatchObject({ mode: "queued", jobRunId: queued.jobRunId, alreadyRunning: true });
    const jobs = jobsFor(QUEUE.IMPORTS);
    expect(jobs).toEqual([expect.objectContaining({ payload: { jobRunId: queued.jobRunId }, opts: { jobId: `import_${queued.jobRunId}` } })]);
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } })).toMatchObject({
      kind: "ANALYTICS_IMPORT",
      orgId: org.id,
      projectId: project.id,
      createdById: owner.id,
      input: { source: "AMPLITUDE", integrationId: integ.id, startDate: "2026-10-01", endDate: "2026-10-03" },
    });

    mockedFetch
      .mockResolvedValueOnce(fakeResponse({ data: [{ value: "Export CSV", totals: 50 }, { value: "Hidden", totals: 99, hidden: true }] }))
      .mockResolvedValueOnce(fakeResponse({ data: { series: [[4, 6, 8]], xValues: ["2026-10-01", "2026-10-02", "2026-10-03"] } }));
    await runWorker(importWorker, jobs[0].payload);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const expectedAuth = `Basic ${Buffer.from("amp-key:amp-secret").toString("base64")}`;
    for (const [url, opts] of mockedFetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/amplitude\.com\/api\/2\//);
      expect(opts?.headers).toMatchObject({ authorization: expectedAuth });
    }
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } });
    expect(run.status).toBe("READY");
    expect(run.output).toMatchObject({ kind: "ANALYTICS_IMPORT", source: "AMPLITUDE", summary: { points: 3, features: 1, metrics: 1 } });
    const row = await prisma.analyticsImport.findFirstOrThrow({ where: { projectId: project.id } });
    expect(row).toMatchObject({ id: (run.output as { importId: string }).importId, source: "AMPLITUDE", integrationId: integ.id });

    // Duplicate delivery never stores the import twice.
    await runWorker(importWorker, jobs[0].payload);
    expect(await prisma.analyticsImport.count()).toBe(1);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    await expect(
      caller.analytics.importData({ projectId: project.id, source: "AMPLITUDE", startDate: "2026-01-01", endDate: "2026-10-03" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("90 days") });
  });

  it("fails a Mixpanel import with a safe message when credentials are rejected", async () => {
    const { owner, org, project } = await setupTeam();
    await seedIntegration(org.id, owner.id, "MIXPANEL", { serviceAccountUsername: "sa", serviceAccountSecret: "secret", projectId: "12345" });
    const queued = expectQueued(
      await callerFor(owner).analytics.importData({ projectId: project.id, source: "MIXPANEL", startDate: "2026-10-01", endDate: "2026-10-03" })
    );
    mockedFetch.mockResolvedValueOnce(fakeResponse({ error: "token abc123 is invalid for project 12345" }, 403));
    await expect(runWorker(importWorker, { jobRunId: queued.jobRunId })).rejects.toThrow();
    expect(String(mockedFetch.mock.calls[0][0])).toMatch(/^https:\/\/mixpanel\.com\/api\/query\/events\/names\?/);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: queued.jobRunId } });
    expect(run).toMatchObject({ status: "FAILED", errorMessage: "Mixpanel rejected the stored credentials. Reconnect the integration and try again." });
    expect(await prisma.analyticsImport.count()).toBe(0);
    await expect(callerFor(owner).job.get({ id: run.id })).resolves.toMatchObject({ status: "FAILED" });
  });

  it("refuses a queued import whose integration belongs to another org", async () => {
    const { owner, org, project } = await setupTeam();
    const other = await setupTeam();
    await seedIntegration(org.id, owner.id, "AMPLITUDE", { apiKey: "k", secretKey: "s" });
    const foreign = await seedIntegration(other.org.id, other.owner.id, "AMPLITUDE", { apiKey: "theirs", secretKey: "theirs" });
    const forged = await prisma.jobRun.create({
      data: {
        kind: "ANALYTICS_IMPORT",
        orgId: org.id,
        projectId: project.id,
        status: "PENDING",
        input: { source: "AMPLITUDE", integrationId: foreign.id, startDate: "2026-10-01", endDate: "2026-10-03" },
      },
    });
    await expect(runWorker(importWorker, { jobRunId: forged.id })).rejects.toThrow();
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: forged.id } })).toMatchObject({ status: "FAILED", errorMessage: expect.stringContaining("not connected") });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("correlation worker", () => {
  it("computes correlations in code, upserts idempotently and emits correlation.found once", async () => {
    const { owner, member, project, themes } = await seedCorrelationProject();
    // A stale correlation from an earlier run must be replaced, not kept.
    await prisma.usageCorrelation.create({
      data: { projectId: project.id, themeId: themes[0].id, featureName: "Old feature", usageMetric: "old", correlationScore: 0.9, direction: "positive", insight: "stale" },
    });
    scriptLLM("analytics.correlation_insight", (req) => {
      expect(req.system).toContain("untrusted_data");
      return { insights: [{ ref: "C1", insight: "Export failures track complaints closely; fix the export job first." }, { ref: "C99", insight: "invented" }] };
    });

    const started = await callerFor(member).analytics.runCorrelation({ projectId: project.id });
    expect(started.alreadyRunning).toBe(false);
    await expect(callerFor(member).analytics.runCorrelation({ projectId: project.id })).resolves.toMatchObject({ jobRunId: started.jobRunId, alreadyRunning: true });
    const job = jobsFor(QUEUE.CORRELATION);
    expect(job).toHaveLength(1);
    expect(job[0].payload).toEqual({ jobRunId: started.jobRunId, projectId: project.id });

    await runWorker(correlationWorker, job[0].payload);
    const run = await prisma.jobRun.findUniqueOrThrow({ where: { id: started.jobRunId } });
    expect(run.status).toBe("READY");
    expect(run.output).toMatchObject({ unit: "day", insightSource: "mixed" });

    const rows = await prisma.usageCorrelation.findMany({ where: { projectId: project.id } });
    const byKey = (feature: string) => rows.find((r) => r.themeId === themes[0].id && r.featureName === feature);
    expect(byKey("CSV export")).toMatchObject({ usageMetric: "export_failures", correlationScore: 1, direction: "positive" });
    expect(byKey("Dashboard")).toMatchObject({ usageMetric: "sessions", correlationScore: -1, direction: "negative" });
    expect(byKey("Settings")).toBeUndefined(); // r = 0
    expect(byKey("Old feature")).toBeUndefined(); // stale row removed
    expect(rows.some((r) => r.insight.startsWith("Export failures track complaints"))).toBe(true);
    expect(rows.filter((r) => !r.insight.startsWith("Export failures")).every((r) => /r = -?\d/.test(r.insight))).toBe(true);

    const events = await prisma.domainEvent.findMany({ where: { type: "correlation.found" } });
    expect(events).toHaveLength(2);
    const count = rows.length;

    // Duplicate delivery of the same job: no changes.
    await runWorker(correlationWorker, job[0].payload);
    expect(await prisma.usageCorrelation.count()).toBe(count);

    // A new run over the same data upserts the same rows and emits nothing new.
    scriptLLM("analytics.correlation_insight", () => {
      throw new Error("LLM unavailable");
    });
    const again = await callerFor(owner).analytics.runCorrelation({ projectId: project.id });
    await runWorker(correlationWorker, { jobRunId: again.jobRunId, projectId: project.id });
    const after = await prisma.usageCorrelation.findMany({ where: { projectId: project.id } });
    expect(after).toHaveLength(count);
    expect(after.map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(after.every((r) => /r = -?\d/.test(r.insight))).toBe(true); // statistical fallback
    expect(await prisma.domainEvent.count({ where: { type: "correlation.found" } })).toBe(2);
    expect((await prisma.jobRun.findUniqueOrThrow({ where: { id: again.jobRunId } })).output).toMatchObject({ insightSource: "statistical" });

    const negative = await callerFor(owner).analytics.getCorrelations({ projectId: project.id, direction: "negative", limit: 1 });
    expect(negative.items[0]).toMatchObject({ direction: "negative", correlationScore: -1, theme: { id: themes[0].id } });
  });

  it("fails the run with a clear message when there is no usage data", async () => {
    const { owner, project } = await setupTeam();
    await seedSynthesis(project.id, [{ name: "Theme", mentions: [{ date: DATES[0], quote: "q" }] }]);
    await expect(callerFor(owner).analytics.runCorrelation({ projectId: project.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const run = await prisma.jobRun.create({ data: { kind: "CORRELATION", orgId: project.orgId, projectId: project.id, status: "PENDING" } });
    await expect(runWorker(correlationWorker, { jobRunId: run.id, projectId: project.id })).rejects.toThrow();
    const failed = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed).toMatchObject({ status: "FAILED", errorMessage: expect.stringContaining("Import analytics data") });
    const viaJob = await callerFor(owner).job.get({ id: run.id });
    expect(viaJob.status).toBe("FAILED");
  });

  it("refuses a job whose run belongs to a different project", async () => {
    const { project } = await setupTeam();
    const other = await setupTeam();
    const run = await prisma.jobRun.create({ data: { kind: "CORRELATION", orgId: project.orgId, projectId: project.id, status: "PENDING" } });
    await expect(runWorker(correlationWorker, { jobRunId: run.id, projectId: other.project.id })).rejects.toThrow();
    expect(await prisma.usageCorrelation.count()).toBe(0);
  });
});
