import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { SafeFetchError } from "@/lib/safe-fetch";
import { QUEUE } from "@/server/jobs/queues";
import { extractReadable, htmlToText } from "@/server/ai/competitive/html";
import { extractCandidates, setCompetitorFetcherForTests, type FetchedPage } from "@/server/ai/competitive/scanner";
import { run as scheduleCompetitive } from "@/server/schedules/competitive";
import { competitiveWorker } from "@/workers/competitive-worker";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { addMember, createOrg, createUser } from "../helpers/factories";
import { callerFor, fakeResponse, runWorker } from "./helpers";

afterEach(() => setCompetitorFetcherForTests(null));

async function workspace() {
  const owner = await createUser();
  const org = await createOrg(owner);
  return { owner, org };
}

const HOME = `<!doctype html><html><head><title>Rival — analytics</title><meta name="description" content="Rival analytics">
<script>window.track = "<h2>not content</h2>";</script><style>.x{}</style></head>
<body><nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
<main><h1>Analytics for product teams</h1><p>Rival helps product teams understand usage &amp; retention across every account in one place.</p></main>
<footer>© Rival Inc</footer></body></html>`;

function changelog(entries: Array<[string, string]>) {
  return `<html><head><title>Changelog</title></head><body><header><nav>Menu</nav></header><main>
${entries.map(([h, p]) => `<h2>${h}</h2><p>${p}</p>`).join("\n")}
</main></body></html>`;
}

const PRICING_V1 = `<html><body><main><h1>Pricing</h1><p>Starter costs $29 per seat per month, Growth costs $59 per seat per month, billed annually.</p></main></body></html>`;
const PRICING_V2 = `<html><body><main><h1>Pricing</h1><p>Starter costs $39 per seat per month, Growth costs $79 per seat per month, billed annually.</p></main></body></html>`;

function site(pages: Record<string, string>) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    if (pages[path] === undefined) return fakeResponse(404, "<html>Not found</html>", {}, url);
    return fakeResponse(200, pages[path], { "content-type": "text/html; charset=utf-8" }, url);
  };
}

function scriptClassifier() {
  scriptLLM("competitive.classify", (req) => {
    const items = [...req.prompt.matchAll(/Section (\d+) \(page type: (\w+)\)/g)].map((m) => {
      const kind = m[2];
      return {
        index: Number(m[1]),
        relevant: kind !== "home",
        type: kind === "pricing" ? "PRICING" : "CHANGELOG",
        title: `${kind} update ${m[1]}`,
        summary: `Summary of ${kind} section ${m[1]}`,
        sentiment: "POSITIVE",
        significance: kind === "pricing" ? "high" : "medium",
      };
    });
    return { items };
  });
}

describe("HTML extraction", () => {
  it("drops scripts, styles, navigation and chrome, decodes entities and keeps the title", () => {
    const r = extractReadable(HOME);
    expect(r.title).toBe("Rival — analytics");
    expect(r.description).toBe("Rival analytics");
    expect(r.text).toContain("usage & retention");
    expect(r.text).not.toMatch(/window\.track|not content|\.x\{|Home|© Rival/);
  });

  it("splits content into heading sections and survives malformed markup", () => {
    const r = extractReadable(`<main><h2>v2.1 <em>Released</em></h2><p>New dashboards<p>Faster exports</p><h2>v2.0</h2><ul><li>SSO<li>SCIM</ul><div title="a>b">x</div><!-- <h2>hidden</h2> -->`);
    expect(r.sections.filter((s) => s.heading).map((s) => s.heading)).toEqual(["v2.1 Released", "v2.0"]);
    const v21 = r.sections.find((s) => s.heading === "v2.1 Released")!;
    expect(v21.text).toContain("New dashboards");
    expect(v21.text).toContain("Faster exports");
    expect(r.sections.find((s) => s.heading === "v2.0")!.text).toContain("- SSO");
    expect(r.text).not.toContain("hidden");
    expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><script>bad()</script>")).toBe("Hi there");
  });

  it("hashes sections stably so unchanged content dedupes", () => {
    const page = (text: string): FetchedPage => ({ url: "https://r.example/changelog", path: "/changelog", kind: "CHANGELOG", title: null, description: null, text, sections: [{ heading: "v1", text }] });
    const a = extractCandidates([page("A".repeat(80) + "   spaced")]);
    const b = extractCandidates([page("A".repeat(80) + " spaced")]);
    expect(a[0].hash).toBe(b[0].hash);
  });
});

describe("competitor router", () => {
  it("allowlists http(s) URLs only", async () => {
    const { owner, org } = await workspace();
    const caller = callerFor(owner, org.id);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://files.example", "file:///etc/passwd", "https://user:pw@rival.example", "not a url"]) {
      await expect(caller.competitive.addCompetitor({ name: "X", website: bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(caller.competitive.addCompetitor({ name: "X", captureUrl: bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    const ok = await caller.competitive.addCompetitor({ name: "Rival", website: "https://rival.example", g2Url: "", description: "" });
    expect(ok).toMatchObject({ website: "https://rival.example", g2Url: null });
    await expect(caller.competitive.updateCompetitor({ id: ok.id, website: "javascript:alert(1)" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const cleared = await caller.competitive.updateCompetitor({ id: ok.id, website: "" });
    expect(cleared.website).toBeNull();
  });

  it("scopes competitors to the org and blocks viewer writes", async () => {
    const { owner, org } = await workspace();
    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    const outsider = await createUser();
    const c = await callerFor(owner, org.id).competitive.addCompetitor({ name: "Rival", website: "https://rival.example" });

    const out = callerFor(outsider);
    await expect(out.competitive.getCompetitor({ id: c.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.competitive.getUpdates({ competitorId: c.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.competitive.removeCompetitor({ id: c.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.competitive.runScan({ id: c.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.competitive.addManualUpdate({ competitorId: c.id, type: "REVIEW", title: "t", content: "c" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await out.competitive.listCompetitors()).items).toHaveLength(0);
    await expect(callerFor(outsider, org.id).competitive.listCompetitors()).rejects.toMatchObject({ code: "NOT_FOUND" });

    const v = callerFor(viewer, org.id);
    expect((await v.competitive.listCompetitors()).items).toHaveLength(1);
    await expect(v.competitive.addCompetitor({ name: "Y" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(v.competitive.removeCompetitor({ id: c.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(v.competitive.runScan({ id: c.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(v.competitive.addManualUpdate({ competitorId: c.id, type: "REVIEW", title: "t", content: "c" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("records manual review insights once", async () => {
    const { owner, org } = await workspace();
    const caller = callerFor(owner, org.id);
    const c = await caller.competitive.addCompetitor({ name: "Rival" });
    const input = { competitorId: c.id, type: "REVIEW" as const, title: "G2: onboarding praised", content: "Reviewers love the setup wizard.", sourceUrl: "https://www.g2.com/products/rival/reviews" };
    const u = await caller.competitive.addManualUpdate(input);
    expect(u).toMatchObject({ isManual: true, type: "REVIEW" });
    await expect(caller.competitive.addManualUpdate(input)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await prisma.domainEvent.count({ where: { type: "competitor.updated" } })).toBe(1);
    expect((await caller.competitive.getUpdates({ competitorId: c.id })).items).toHaveLength(1);
  });

  it("runScan creates a JobRun and enqueues once while it's pending", async () => {
    const { owner, org } = await workspace();
    const caller = callerFor(owner, org.id);
    const c = await caller.competitive.addCompetitor({ name: "Rival", website: "https://rival.example" });
    const first = await caller.competitive.runScan({ id: c.id });
    const second = await caller.competitive.runScan({ id: c.id });
    expect(second).toEqual({ jobRunId: first.jobRunId, alreadyRunning: true });
    expect(jobsFor(QUEUE.COMPETITIVE_SCAN).map((j) => j.payload)).toEqual([{ competitorId: c.id, jobRunId: first.jobRunId }]);
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: first.jobRunId } })).toMatchObject({ status: "PENDING", kind: "COMPETITIVE_SCAN" });
    const noSite = await caller.competitive.addCompetitor({ name: "NoSite" });
    await expect(caller.competitive.runScan({ id: noSite.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("competitive scan worker", () => {
  it("records a baseline, dedupes unchanged content by hash, then alerts on significant changes", async () => {
    const { owner, org } = await workspace();
    const member = await createUser();
    await addMember(org.id, member, "MEMBER");
    const caller = callerFor(owner, org.id);
    const c = await caller.competitive.addCompetitor({ name: "Rival", website: "https://rival.example" });
    scriptClassifier();

    const entries: Array<[string, string]> = [
      ["v3.2 — Funnels", "Funnels now support custom conversion windows and cohort breakdowns for every plan."],
      ["v3.1 — Exports", "Scheduled CSV exports can be delivered to S3 and BigQuery on an hourly cadence."],
    ];
    setCompetitorFetcherForTests(site({ "/": HOME, "/changelog": changelog(entries), "/pricing": PRICING_V1 }));

    // Scan 1: baseline (no alerts).
    const { jobRunId } = await caller.competitive.runScan({ id: c.id });
    const r1 = (await runWorker(competitiveWorker, { competitorId: c.id, jobRunId })) as { updatesCreated: number; baseline: boolean };
    expect(r1).toMatchObject({ baseline: true, updatesCreated: 3 });
    expect(await prisma.competitorUpdate.count({ where: { competitorId: c.id } })).toBe(3);
    expect(await prisma.competitorAlert.count()).toBe(0);
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } })).toMatchObject({ status: "READY" });
    const profile = await prisma.competitorProfile.findUniqueOrThrow({ where: { id: c.id } });
    expect(profile.lastScannedAt).not.toBeNull();
    expect(profile.lastScanError).toBeNull();
    const updates = await prisma.competitorUpdate.findMany({ where: { competitorId: c.id } });
    expect(updates.every((u) => u.sourceUrl?.startsWith("https://rival.example/") && u.contentHash && !u.isManual)).toBe(true);
    // Page text reached the model only as untrusted data.
    expect(llmCalls[0].prompt).toContain('<untrusted_data source="Rival /changelog">');
    expect(llmCalls[0].system).toContain("untrusted_data");

    // Scan 2: nothing changed → no LLM call, no new rows (contentHash dedupe, incl. irrelevant sections).
    const calls = llmCalls.length;
    await runWorker(competitiveWorker, { competitorId: c.id });
    expect(llmCalls.length).toBe(calls);
    expect(await prisma.competitorUpdate.count({ where: { competitorId: c.id } })).toBe(3);

    // Scan 3: a new changelog entry and a price change → new updates, alert on the pricing change.
    setCompetitorFetcherForTests(
      site({ "/": HOME, "/changelog": changelog([["v3.3 — AI summaries", "Every dashboard can now be summarized by an assistant in one click."], ...entries]), "/pricing": PRICING_V2 })
    );
    const r3 = (await runWorker(competitiveWorker, { competitorId: c.id })) as { updatesCreated: number; alertsCreated: number; baseline: boolean };
    expect(r3).toMatchObject({ baseline: false, updatesCreated: 2, alertsCreated: 2 });
    const alerts = await prisma.competitorAlert.findMany({ orderBy: { userId: "asc" } });
    expect(alerts.map((a) => a.type)).toEqual(["PRICING_CHANGE", "PRICING_CHANGE"]);
    expect(new Set(alerts.map((a) => a.userId))).toEqual(new Set([owner.id, member.id]));
    expect(await prisma.notification.count({ where: { type: "COMPETITOR_ALERT" } })).toBe(2);
    expect(await prisma.domainEvent.count({ where: { type: "competitor.updated" } })).toBe(5);

    // Alerts are per user; marking read is scoped to the caller.
    const mine = await caller.competitive.getAlerts({ unreadOnly: true });
    expect(mine.unread).toBe(1);
    await caller.competitive.markAlertRead({ id: mine.items[0].id });
    await expect(callerFor(member, org.id).competitive.markAlertRead({ id: mine.items[0].id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await caller.competitive.getAlerts({ unreadOnly: true })).unread).toBe(0);
    expect((await callerFor(member, org.id).competitive.getAlerts({ unreadOnly: true })).unread).toBe(1);
  });

  it("a deleted scanned update isn't re-created by the next scan", async () => {
    const { owner, org } = await workspace();
    const caller = callerFor(owner, org.id);
    const c = await caller.competitive.addCompetitor({ name: "Rival", website: "https://rival.example" });
    scriptClassifier();
    setCompetitorFetcherForTests(site({ "/": HOME, "/pricing": PRICING_V1 }));
    await runWorker(competitiveWorker, { competitorId: c.id });
    const [u] = (await caller.competitive.getUpdates({ competitorId: c.id })).items;
    await caller.competitive.deleteUpdate({ id: u.id });
    await runWorker(competitiveWorker, { competitorId: c.id });
    expect(await prisma.competitorUpdate.count({ where: { competitorId: c.id } })).toBe(0);
  });

  it("records failures as failures (lastScanError, JobRun FAILED) and never fetches private addresses", async () => {
    const { owner, org } = await workspace();
    const caller = callerFor(owner, org.id);
    const c = await caller.competitive.addCompetitor({ name: "Internal", website: "https://intranet.example" });
    setCompetitorFetcherForTests(async () => {
      throw new SafeFetchError("Destination address is not allowed", "BLOCKED_ADDRESS");
    });
    const { jobRunId } = await caller.competitive.runScan({ id: c.id });
    await expect(runWorker(competitiveWorker, { competitorId: c.id, jobRunId })).rejects.toThrow();
    const profile = await prisma.competitorProfile.findUniqueOrThrow({ where: { id: c.id } });
    expect(profile.lastScanError).toMatch(/Address not allowed/);
    expect(await prisma.jobRun.findUniqueOrThrow({ where: { id: jobRunId } })).toMatchObject({ status: "FAILED", errorMessage: expect.stringMatching(/Address not allowed/) });
    expect(await prisma.competitorUpdate.count()).toBe(0);
  });

  it("retries transient network failures instead of failing the scan", async () => {
    const { owner, org } = await workspace();
    const c = await callerFor(owner, org.id).competitive.addCompetitor({ name: "Flaky", website: "https://flaky.example" });
    setCompetitorFetcherForTests(async () => {
      throw new SafeFetchError("Request timed out", "TIMEOUT");
    });
    await expect(runWorker(competitiveWorker, { competitorId: c.id }, 1, 3)).rejects.toThrow(/Couldn't read/);
    expect((await prisma.competitorProfile.findUniqueOrThrow({ where: { id: c.id } })).lastScanError).toBeNull();
    await expect(runWorker(competitiveWorker, { competitorId: c.id }, 3, 3)).rejects.toThrow();
    expect((await prisma.competitorProfile.findUniqueOrThrow({ where: { id: c.id } })).lastScanError).toMatch(/timeout/);
  });
});

describe("competitive schedule", () => {
  it("enqueues competitors not scanned in 24h, once per day", async () => {
    const { owner, org } = await workspace();
    const caller = callerFor(owner, org.id);
    const due = await caller.competitive.addCompetitor({ name: "Due", website: "https://due.example" });
    const fresh = await caller.competitive.addCompetitor({ name: "Fresh", website: "https://fresh.example" });
    await prisma.competitorProfile.update({ where: { id: fresh.id }, data: { lastScannedAt: new Date() } });
    await caller.competitive.addCompetitor({ name: "No site" });
    expect(await scheduleCompetitive()).toBe(1);
    await scheduleCompetitive();
    const jobs = jobsFor(QUEUE.COMPETITIVE_SCAN);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ competitorId: due.id });
  });
});
