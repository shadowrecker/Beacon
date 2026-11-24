import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { createDocumentFromText } from "@/server/documents/ingest";
import { getLatestThemes } from "@/server/synthesis/queries";
import { documentWorker } from "@/workers/document-worker";
import { synthesisWorker } from "@/workers/synthesis-worker";
import { FEATURES } from "@/server/ai/prompts";
import { jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { createProject, createUser } from "../helpers/factories";
import { callerFor, chunksInPrompt, eventsOfType, runWorker } from "./helpers";

const DOCS: Record<string, string> = {
  "Interview: Dana": "Dana: The CSV export times out on large workspaces every Monday. I lose the whole morning.",
  "Ticket 1042": "Customer: Export to CSV fails with a timeout when we have more than ten thousand rows.",
  "Interview: Lee": "Lee: We cannot roll out without SSO. Our security team requires single sign-on for every tool.",
};

async function seedProject() {
  const user = await createUser();
  const project = await createProject(user);
  for (const [title, text] of Object.entries(DOCS)) {
    const { documentId } = await createDocumentFromText({ projectId: project.id, title, type: "TRANSCRIPT", source: "QUICK_CAPTURE", text });
    await runWorker(documentWorker, { documentId });
  }
  return { user, project };
}

/** Fake extraction: one insight per excerpt, quoting its first sentence; plus fabricated evidence. */
function scriptExtraction(opts: { failTitles?: string[] } = {}) {
  scriptLLM(FEATURES.synthesisExtract, (req) => {
    const title = req.prompt.match(/source="document-title">\n([^\n]+)\n/)?.[1] ?? "";
    if (opts.failTitles?.includes(title)) throw new Error("upstream overloaded");
    const chunks = chunksInPrompt(req.prompt);
    return {
      segment: "mid-market",
      insights: chunks.map((c) => {
        const sentence = c.text.split(/(?<=\.)\s/)[0];
        const isExport = /export/i.test(c.text);
        return {
          kind: isExport ? "pain_point" : "feature_request",
          summary: isExport ? "CSV export times out on large workspaces" : "Customers need SSO before rollout",
          severity: "high",
          sentiment: "NEGATIVE",
          productArea: isExport ? "Reporting" : "Security",
          evidence: [
            { chunkId: c.id, quote: sentence.replace(/^\w+: /, "") },
            { chunkId: c.id, quote: "a quote that does not appear anywhere" },
            { chunkId: "fabricated", quote: sentence },
          ],
        };
      }),
    };
  });
}

/** Fake clustering: group insight ids by summary keyword. */
function scriptClustering() {
  scriptLLM(FEATURES.synthesisCluster, (req) => {
    const lines = [...req.prompt.matchAll(/^(i\d+) \[[^\]]*\] (.+)$/gm)];
    const exportIds = lines.filter((l) => /export/i.test(l[2])).map((l) => l[1]);
    const ssoIds = lines.filter((l) => /sso/i.test(l[2])).map((l) => l[1]);
    return {
      themes: [
        { name: "CSV export times out", description: "Large exports fail.", insightIds: [...exportIds, "i999"] },
        { name: "SSO required for rollout", description: "Security teams block adoption.", insightIds: ssoIds },
        { name: "Empty theme", description: "No valid ids.", insightIds: ["i404"] },
      ],
    };
  });
}

describe("synthesis.run", () => {
  it("creates a PENDING row and enqueues it; a second click while running returns the same run", async () => {
    const { user, project } = await seedProject();
    const caller = callerFor(user);
    const run = await caller.synthesis.run({ projectId: project.id, type: "FULL" });
    expect(run).toMatchObject({ status: "PENDING", alreadyRunning: false });
    expect(jobsFor(QUEUE.SYNTHESIS).map((j) => j.payload)).toEqual([{ synthesisId: run.id }]);
    const again = await caller.synthesis.run({ projectId: project.id, type: "FULL" });
    expect(again).toMatchObject({ id: run.id, alreadyRunning: true });
    expect(jobsFor(QUEUE.SYNTHESIS)).toHaveLength(1);
  });

  it("requires processed documents", async () => {
    const user = await createUser();
    const project = await createProject(user);
    await expect(callerFor(user).synthesis.run({ projectId: project.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("synthesis worker", () => {
  it("map-reduces documents into themes with verified citations, idempotently", async () => {
    const { user, project } = await seedProject();
    scriptExtraction();
    scriptClustering();
    const { id } = await callerFor(user).synthesis.run({ projectId: project.id, type: "FULL" });
    await runWorker(synthesisWorker, { synthesisId: id });

    const s = await prisma.synthesis.findUniqueOrThrow({ where: { id } });
    expect(s.status).toBe("READY");
    expect(s.completedAt).not.toBeNull();
    expect(s.output).toMatchObject({ documentsAnalyzed: 3, skippedDocuments: [], insightCount: 3, themeCount: 2 });
    expect(llmCalls.filter((c) => c.feature === FEATURES.synthesisExtract)).toHaveLength(3);
    for (const call of llmCalls) expect(call.system).toContain("untrusted_data");

    const themes = await prisma.theme.findMany({ where: { synthesisId: id }, include: { citations: { include: { chunk: true } } } });
    expect(themes.map((t) => t.name).sort()).toEqual(["CSV export times out", "SSO required for rollout"]);
    for (const t of themes) {
      expect(t.citations.length).toBeGreaterThan(0);
      for (const c of t.citations) {
        expect(c.chunk.projectId).toBe(project.id);
        expect(c.chunk.content).toContain(c.quote);
      }
    }
    const exportTheme = themes.find((t) => t.name === "CSV export times out")!;
    expect(exportTheme.sentiment).toBe("NEGATIVE");
    expect(exportTheme.citations).toHaveLength(2); // fabricated evidence dropped
    // Two of three documents, two quotes: confidence from the documented formula.
    expect(exportTheme.confidenceScore).toBeCloseTo(0.45 * (2 / 3) + 0.3 * (2 / 4) + 0.25 * (2 / 3), 3);

    expect((await eventsOfType("synthesis.completed")).map((e) => e.payload)).toEqual([{ synthesisId: id, themeCount: 2 }]);
    expect(await eventsOfType("theme.detected")).toHaveLength(2);

    // UI shape and the shared read helper.
    const detail = await callerFor(user).synthesis.getById({ projectId: project.id, id });
    expect(detail.summary).toMatchObject({ documentsAnalyzed: 3, skippedDocuments: [] });
    expect(detail.themes[0]).toMatchObject({
      name: "CSV export times out",
      sentiment: "NEGATIVE",
      citationCount: 2,
      frequency: 2,
      severity: "high",
      productAreas: ["Reporting"],
      segments: ["mid-market"],
    });
    expect(detail.themes[0].topQuotes[0]).toMatchObject({ documentTitle: expect.any(String), position: 0 });
    const latest = await getLatestThemes(project.id);
    expect(latest.synthesisId).toBe(id);
    expect(latest.themes).toHaveLength(2);

    const citations = await callerFor(user).synthesis.themeCitations({ projectId: project.id, themeId: exportTheme.id, limit: 1 });
    expect(citations.items).toHaveLength(1);
    expect(citations.nextCursor).not.toBeNull();

    // A retried job replaces this synthesis' themes instead of duplicating them.
    await prisma.synthesis.update({ where: { id }, data: { status: "PROCESSING" } });
    await runWorker(synthesisWorker, { synthesisId: id });
    expect(await prisma.theme.count({ where: { synthesisId: id } })).toBe(2);
    expect(await prisma.citation.count({ where: { theme: { synthesisId: id } } })).toBe(themes.reduce((n, t) => n + t.citations.length, 0));
  });

  it("filters insights by synthesis type", async () => {
    const { user, project } = await seedProject();
    scriptExtraction();
    scriptClustering();
    const { id } = await callerFor(user).synthesis.run({ projectId: project.id, type: "PAIN_POINTS" });
    await runWorker(synthesisWorker, { synthesisId: id });
    const themes = await prisma.theme.findMany({ where: { synthesisId: id } });
    expect(themes.map((t) => t.name)).toEqual(["CSV export times out"]);
  });

  it("records documents whose extraction failed instead of dropping them silently", async () => {
    const { user, project } = await seedProject();
    scriptExtraction({ failTitles: ["Interview: Lee"] });
    scriptClustering();
    const { id } = await callerFor(user).synthesis.run({ projectId: project.id });
    await runWorker(synthesisWorker, { synthesisId: id });
    const s = await prisma.synthesis.findUniqueOrThrow({ where: { id } });
    expect(s.status).toBe("READY");
    expect(s.output).toMatchObject({ documentsAnalyzed: 2, skippedDocuments: [{ title: "Interview: Lee", reason: "upstream overloaded" }] });
    const detail = await callerFor(user).synthesis.getById({ projectId: project.id, id });
    expect(detail.summary?.skippedDocuments).toHaveLength(1);
  });

  it("merges themes across clustering batches when there are many insights", async () => {
    const user = await createUser();
    const project = await createProject(user);
    for (let d = 0; d < 7; d++) {
      const text = Array.from({ length: 25 }, (_, i) => `Customer ${d}-${i} says the CSV export times out again.`).join(" ");
      const { documentId } = await createDocumentFromText({ projectId: project.id, title: `Doc ${d}`, type: "NOTE", source: "QUICK_CAPTURE", text });
      await runWorker(documentWorker, { documentId });
    }
    scriptLLM(FEATURES.synthesisExtract, (req) => {
      const [chunk] = chunksInPrompt(req.prompt);
      return {
        segment: null,
        insights: Array.from({ length: 25 }, () => ({
          kind: "pain_point",
          summary: "CSV export times out",
          severity: "medium",
          sentiment: "NEGATIVE",
          productArea: null,
          evidence: [{ chunkId: chunk.id, quote: "says the CSV export times out again" }],
        })),
      };
    });
    scriptLLM(FEATURES.synthesisCluster, (req) => ({
      themes: [{ name: "Export timeouts", description: "Exports fail.", insightIds: [...req.prompt.matchAll(/^(i\d+) /gm)].map((m) => m[1]) }],
    }));
    scriptLLM(FEATURES.synthesisMerge, (req) => ({
      themes: [{ name: "Export timeouts", description: "Exports fail for large workspaces.", sourceThemeIds: [...req.prompt.matchAll(/^(t\d+) /gm)].map((m) => m[1]) }],
    }));
    const { id } = await callerFor(user).synthesis.run({ projectId: project.id });
    await runWorker(synthesisWorker, { synthesisId: id });
    expect(llmCalls.filter((c) => c.feature === FEATURES.synthesisCluster)).toHaveLength(2);
    expect(llmCalls.filter((c) => c.feature === FEATURES.synthesisMerge)).toHaveLength(1);
    const detail = await callerFor(user).synthesis.getById({ projectId: project.id, id });
    expect(detail.themes).toHaveLength(1);
    expect(detail.themes[0]).toMatchObject({ name: "Export timeouts", insightCount: 175, frequency: 7, severity: "medium" });
  });

  it("fails the same row with a reason when nothing can be analyzed, and stops polling on FAILED", async () => {
    const { user, project } = await seedProject();
    scriptExtraction({ failTitles: Object.keys(DOCS) });
    const { id } = await callerFor(user).synthesis.run({ projectId: project.id });
    await expect(runWorker(synthesisWorker, { synthesisId: id }, 1, 2)).rejects.toThrow();
    expect((await prisma.synthesis.findUniqueOrThrow({ where: { id } })).status).toBe("PROCESSING");
    await expect(runWorker(synthesisWorker, { synthesisId: id }, 2, 2)).rejects.toThrow();
    const status = await callerFor(user).synthesis.getStatus({ projectId: project.id, id });
    expect(status).toMatchObject({ status: "FAILED", errorMessage: "None of the documents could be analyzed" });
    expect(await prisma.synthesis.count({ where: { projectId: project.id } })).toBe(1);
    expect(await eventsOfType("synthesis.failed")).toHaveLength(1);
  });

  it("lists runs with summary fields", async () => {
    const { user, project } = await seedProject();
    scriptExtraction();
    scriptClustering();
    const { id } = await callerFor(user).synthesis.run({ projectId: project.id });
    await runWorker(synthesisWorker, { synthesisId: id });
    const list = await callerFor(user).synthesis.list({ projectId: project.id });
    expect(list.items).toEqual([expect.objectContaining({ id, status: "READY", themeCount: 2, documentsAnalyzed: 3, skippedCount: 0 })]);
  });
});

describe("synthesis causation depth (workflow loop guard)", () => {
  it("emits its events at the depth recorded on the synthesis", async () => {
    const { project } = await seedProject();
    scriptExtraction();
    scriptClustering();
    // As if created by a workflow's RUN_SYNTHESIS action triggered at depth 1.
    const synthesis = await prisma.synthesis.create({ data: { projectId: project.id, type: "FULL", status: "PENDING", causationDepth: 2 } });
    await runWorker(synthesisWorker, { synthesisId: synthesis.id });
    const completed = await prisma.domainEvent.findMany({ where: { projectId: project.id, type: "synthesis.completed" } });
    const themes = await prisma.domainEvent.findMany({ where: { projectId: project.id, type: "theme.detected" } });
    expect(completed).toHaveLength(1);
    expect(completed[0].causationDepth).toBe(2);
    expect(themes.length).toBeGreaterThan(0);
    expect(themes.every((e) => e.causationDepth === 2)).toBe(true);
  });
});
