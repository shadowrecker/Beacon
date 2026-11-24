import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { presentationWorker } from "@/workers/presentation-worker";
import { safeThemeColor } from "@/server/ai/presentation/schema";
import { jobsFor, llmCalls, scriptLLM, storage } from "../helpers/doubles";
import { callerFor, runWorker, seedRecommendation, seedSynthesis, setupTeam } from "./helpers";

function scriptDeck(slideCount = 3) {
  scriptLLM("presentation.generate", (req) => {
    expect(req.system).toContain("untrusted_data");
    expect(req.prompt).toContain("CSV export times out");
    return {
      slides: Array.from({ length: slideCount }, (_, i) => ({
        layout: i === 0 ? "title" : i === slideCount - 1 ? "conclusion" : "content",
        title: i === 0 ? "Q3 customer readout" : `Finding ${i}`,
        subtitle: i === 0 ? "What customers told us" : "",
        bulletPoints: i === 0 ? [] : ["Exports time out on large workspaces", "  ", "Enterprise admins are blocked"],
        speakerNotes: `Notes for slide ${i + 1}`,
      })),
    };
  });
}

async function readyPresentation() {
  const team = await setupTeam();
  await seedSynthesis(team.project.id, [{ name: "CSV export times out", mentions: [{ date: "2026-10-01", quote: "Exports time out" }] }]);
  await seedRecommendation(team.project.id);
  const created = await callerFor(team.member).presentation.create({
    projectId: team.project.id,
    title: "Q3 readout",
    audience: "EXECUTIVE",
    type: "SYNTHESIS_READOUT",
    themeColor: "#1e40af",
  });
  scriptDeck();
  await runWorker(presentationWorker, { presentationId: created.id });
  return { ...team, presentationId: created.id };
}

describe("presentation input validation", () => {
  it("accepts only #RRGGBB theme colors", async () => {
    const { member, project } = await setupTeam();
    const caller = callerFor(member);
    const base = { projectId: project.id, title: "Deck", audience: "EXECUTIVE" as const, type: "QBR" as const };
    for (const bad of ["red", "#12345", "#1234567", "#12345G", "#123456;}</style><script>alert(1)</script>", "rgb(0,0,0)", "url(javascript:x)"]) {
      await expect(caller.presentation.create({ ...base, themeColor: bad })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await prisma.presentation.count()).toBe(0);
    const ok = await caller.presentation.create({ ...base, themeColor: "#aabbcc" });
    expect((await prisma.presentation.findUniqueOrThrow({ where: { id: ok.id } })).themeColor).toBe("#AABBCC");
    expect(safeThemeColor("#123456;}</style>")).toBe("#3B82F6");
  });

  it("only uses templates visible to the project's org", async () => {
    const { member, project } = await setupTeam();
    const other = await setupTeam();
    const privateTemplate = await prisma.presentationTemplate.create({
      data: { name: "Secret", audience: "EXECUTIVE", type: "QBR", structure: [{ title: "Hidden slide" }], isPublic: false, orgId: other.org.id, createdBy: other.owner.id },
    });
    const base = { projectId: project.id, title: "Deck", audience: "EXECUTIVE" as const, type: "QBR" as const };
    await expect(callerFor(member).presentation.create({ ...base, templateId: privateTemplate.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(member).presentation.create({ ...base, templateId: "builtin:NOPE" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const templates = await callerFor(member).presentation.listTemplates();
    expect(templates.some((t) => t.id === "builtin:EXECUTIVE_SYNTHESIS" && t.builtIn)).toBe(true);
    expect(templates.some((t) => t.id === privateTemplate.id)).toBe(false);
    expect(await callerFor(other.owner).presentation.listTemplates()).toEqual(expect.arrayContaining([expect.objectContaining({ id: privateTemplate.id })]));

    await seedSynthesis(project.id, [{ name: "CSV export times out" }]);
    const created = await callerFor(member).presentation.create({ ...base, templateId: "builtin:EXECUTIVE_SYNTHESIS" });
    scriptDeck();
    await runWorker(presentationWorker, { presentationId: created.id });
    expect(llmCalls[0].prompt).toContain('"Executive Synthesis" template');
    expect(llmCalls[0].prompt).toContain("Market Opportunity");
  });
});

describe("presentation worker", () => {
  it("generates slides, writes PPTX and PDF keys to storage and becomes READY", async () => {
    const { member, project, presentationId } = await (async () => {
      const team = await setupTeam();
      await seedSynthesis(team.project.id, [{ name: "CSV export times out", mentions: [{ date: "2026-10-01", quote: "Exports time out" }] }]);
      await seedRecommendation(team.project.id);
      const created = await callerFor(team.member).presentation.create({ projectId: team.project.id, title: "Q3 readout", audience: "BOARD", type: "QBR" });
      expect(created.status).toBe("GENERATING");
      return { ...team, presentationId: created.id };
    })();
    const jobs = jobsFor(QUEUE.PRESENTATIONS);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ presentationId });

    scriptDeck(4);
    await runWorker(presentationWorker, jobs[0].payload);

    const row = await prisma.presentation.findUniqueOrThrow({ where: { id: presentationId } });
    expect(row.status).toBe("READY");
    expect(row.errorMessage).toBeNull();
    expect(row.pptxUrl).toBe(`projects/${project.id}/presentations/${presentationId}/deck.pptx`);
    expect(row.pdfUrl).toBe(`projects/${project.id}/presentations/${presentationId}/deck.pdf`);
    const pptx = storage.objects.get(row.pptxUrl!);
    const pdf = storage.objects.get(row.pdfUrl!);
    expect(pptx?.body.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(pptx?.contentType).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(pdf?.body.subarray(0, 4).toString("latin1")).toBe("%PDF");

    const detail = await callerFor(member).presentation.get({ id: presentationId });
    expect(detail.slides).toHaveLength(4);
    expect(detail.slides[1]).toMatchObject({ slideNumber: 2, layout: "content", bulletPoints: ["Exports time out on large workspaces", "Enterprise admins are blocked"] });
    expect(detail).toMatchObject({ status: "READY", hasPptx: true, hasPdf: true, revision: 1 });

    expect(await prisma.domainEvent.count({ where: { type: "presentation.ready" } })).toBe(1);
    // Duplicate delivery: nothing regenerated, no new event.
    await runWorker(presentationWorker, jobs[0].payload);
    expect(llmCalls).toHaveLength(1);
    expect(await prisma.domainEvent.count({ where: { type: "presentation.ready" } })).toBe(1);
  });

  it("marks the presentation FAILED with a message when generation fails", async () => {
    const { member, project } = await setupTeam();
    await seedSynthesis(project.id, [{ name: "CSV export times out" }]);
    const created = await callerFor(member).presentation.create({ projectId: project.id, title: "Deck", audience: "SALES", type: "CUSTOM" });
    scriptLLM("presentation.generate", () => ({ slides: "nope" }));
    await expect(runWorker(presentationWorker, { presentationId: created.id })).rejects.toThrow();
    const row = await prisma.presentation.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBeTruthy();
    expect(row.pptxUrl).toBeNull();
    expect(storage.objects.size).toBe(0);
  });

  it("fails without data to present", async () => {
    const { member, project } = await setupTeam();
    const created = await callerFor(member).presentation.create({ projectId: project.id, title: "Deck", audience: "SALES", type: "CUSTOM" });
    await expect(runWorker(presentationWorker, { presentationId: created.id })).rejects.toThrow();
    expect(await prisma.presentation.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({
      status: "FAILED",
      errorMessage: expect.stringContaining("nothing to present"),
    });
  });
});

describe("presentation editing and export", () => {
  it("validates slide edits, re-renders exports on demand and returns presigned URLs", async () => {
    const { member, project, presentationId } = await readyPresentation();
    const caller = callerFor(member);

    await expect(caller.presentation.updateSlide({ id: presentationId, slideNumber: 2, title: "  ", bulletPoints: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.presentation.updateSlide({ id: presentationId, slideNumber: 2, title: "Too many", bulletPoints: Array.from({ length: 9 }, (_, i) => `b${i}`) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.presentation.updateSlide({ id: presentationId, slideNumber: 30, title: "Missing", bulletPoints: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const first = await caller.presentation.exportPptx({ id: presentationId });
    expect(first.rerendered).toBe(false);
    expect(first.url).toContain(encodeURIComponent(`projects/${project.id}/presentations/${presentationId}/deck.pptx`));
    expect(first.fileName).toBe("Q3_readout.pptx");

    const edited = await caller.presentation.updateSlide({
      id: presentationId,
      slideNumber: 2,
      title: "Exports are the top issue",
      subtitle: "",
      bulletPoints: ["Fix the export job", ""],
      speakerNotes: "Lead with this",
      layout: "section",
    });
    expect(edited).toMatchObject({ revision: 2, slide: { title: "Exports are the top issue", bulletPoints: ["Fix the export job"], layout: "section" } });

    const before = storage.objects.get(`projects/${project.id}/presentations/${presentationId}/deck.pdf`)!.body;
    const pdf = await caller.presentation.exportPdf({ id: presentationId });
    expect(pdf.rerendered).toBe(true);
    expect(storage.objects.get(`projects/${project.id}/presentations/${presentationId}/deck.pdf`)!.body.equals(before)).toBe(false);
    const again = await caller.presentation.exportPdf({ id: presentationId });
    expect(again.rerendered).toBe(false);
    expect((await caller.presentation.exportPptx({ id: presentationId })).rerendered).toBe(true);
  });

  it("deletes the stored objects with the presentation", async () => {
    const { owner, project, presentationId } = await readyPresentation();
    expect([...storage.objects.keys()].filter((k) => k.startsWith(`projects/${project.id}/presentations/`))).toHaveLength(2);
    await callerFor(owner).presentation.delete({ id: presentationId });
    expect(await prisma.presentation.count()).toBe(0);
    expect([...storage.objects.keys()].filter((k) => k.startsWith(`projects/${project.id}/presentations/`))).toHaveLength(0);
  });

  it("regenerates once per click and refuses while generating", async () => {
    const { member, presentationId } = await readyPresentation();
    await callerFor(member).presentation.regenerate({ id: presentationId });
    await expect(callerFor(member).presentation.regenerate({ id: presentationId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(jobsFor(QUEUE.PRESENTATIONS)).toHaveLength(2); // create + one regenerate
    scriptDeck(2);
    await runWorker(presentationWorker, jobsFor(QUEUE.PRESENTATIONS)[1].payload);
    const detail = await callerFor(member).presentation.get({ id: presentationId });
    expect(detail).toMatchObject({ status: "READY", revision: 2 });
    expect(detail.slides).toHaveLength(2);
    expect(await prisma.domainEvent.count({ where: { type: "presentation.ready" } })).toBe(2);
  });
});

describe("presentation authorization", () => {
  it("hides presentations from outsiders and blocks viewer writes", async () => {
    const { viewer, outsider, project, presentationId } = await readyPresentation();
    const out = callerFor(outsider);
    await expect(out.presentation.get({ id: presentationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.presentation.list({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.presentation.exportPptx({ id: presentationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.presentation.updateSlide({ id: presentationId, slideNumber: 1, title: "x", bulletPoints: [] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.presentation.delete({ id: presentationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.presentation.create({ projectId: project.id, title: "x", audience: "EXECUTIVE", type: "QBR" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const v = callerFor(viewer);
    await expect(v.presentation.get({ id: presentationId })).resolves.toMatchObject({ id: presentationId });
    await expect(v.presentation.list({ projectId: project.id })).resolves.toMatchObject({ items: [expect.objectContaining({ id: presentationId })] });
    await expect(v.presentation.create({ projectId: project.id, title: "x", audience: "EXECUTIVE", type: "QBR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(v.presentation.regenerate({ id: presentationId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(v.presentation.updateSlide({ id: presentationId, slideNumber: 1, title: "x", bulletPoints: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(v.presentation.delete({ id: presentationId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(v.presentation.exportPdf({ id: presentationId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.presentation.count()).toBe(1);
  });
});
