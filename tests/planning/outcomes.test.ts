import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { emitEvent } from "@/server/events/bus";
import { outcomesSubscriber } from "@/server/events/subscribers/outcomes";
import { computeProgress } from "@/server/ai/outcomes/tracker";
import { computeLearningSummary, getLearningContext, scoreAdjustment } from "@/server/ai/outcomes/learning-engine";
import { isSafeHttpUrl } from "@/server/ai/outcomes/decision-logger";
import { callerFor, seedRecommendation, setupTeam } from "./helpers";

async function statusChangedEvent(orgId: string, projectId: string, recommendationId: string, to: string) {
  const id = await emitEvent({
    orgId,
    projectId,
    type: "recommendation.status_changed",
    payload: { recommendationId, title: "Rec", from: "ACCEPTED", to },
  });
  return prisma.domainEvent.findUniqueOrThrow({ where: { id } });
}

describe("outcomes subscriber", () => {
  it("starts tracking exactly once when a recommendation is implemented", async () => {
    const { project, org } = await setupTeam();
    const rec = await seedRecommendation(project.id, { status: "IMPLEMENTED" });
    const event = await statusChangedEvent(org.id, project.id, rec.id, "IMPLEMENTED");
    expect(outcomesSubscriber.handles(event.type)).toBe(true);

    // Concurrent and repeated deliveries.
    await Promise.all([outcomesSubscriber.handle(event, logger), outcomesSubscriber.handle(event, logger)]);
    await outcomesSubscriber.handle(event, logger);

    const rows = await prisma.outcomeTracking.findMany({ where: { recommendationId: rec.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SHIPPED");
    expect(rows[0].shippedAt).toBeInstanceOf(Date);
    expect(await prisma.domainEvent.count({ where: { type: "outcome.updated" } })).toBe(1);
  });

  it("ignores other transitions and events from another org", async () => {
    const { project, org } = await setupTeam();
    const other = await setupTeam();
    const rec = await seedRecommendation(project.id, { status: "IMPLEMENTED" });
    await outcomesSubscriber.handle(await statusChangedEvent(org.id, project.id, rec.id, "ACCEPTED"), logger);
    // An event in another org naming this org's recommendation must not act on it.
    await outcomesSubscriber.handle(await statusChangedEvent(other.org.id, other.project.id, rec.id, "IMPLEMENTED"), logger);
    expect(await prisma.outcomeTracking.count()).toBe(0);
    expect(outcomesSubscriber.handles("recommendation.created")).toBe(false);
  });

  it("promotes an existing NOT_SHIPPED tracking row instead of adding one", async () => {
    const { project, org } = await setupTeam();
    const rec = await seedRecommendation(project.id, { status: "IMPLEMENTED" });
    await prisma.outcomeTracking.create({ data: { recommendationId: rec.id, status: "NOT_SHIPPED", metricName: "Exports/week" } });
    await outcomesSubscriber.handle(await statusChangedEvent(org.id, project.id, rec.id, "IMPLEMENTED"), logger);
    const rows = await prisma.outcomeTracking.findMany({ where: { recommendationId: rec.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SHIPPED", metricName: "Exports/week" });
  });
});

describe("outcome router", () => {
  it("tracks and updates outcomes with progress toward target", async () => {
    const { member, viewer, outsider, project } = await setupTeam();
    const rec = await seedRecommendation(project.id, { status: "IMPLEMENTED" });
    const caller = callerFor(member);

    const tracked = await caller.outcome.track({ projectId: project.id, recommendationId: rec.id, metricName: "Export success rate", baselineValue: 80, targetValue: 95 });
    expect(tracked).toMatchObject({ status: "SHIPPED", metricName: "Export success rate", progress: null, recommendation: { id: rec.id, title: rec.title } });
    expect(tracked.shippedAt).toBeInstanceOf(Date);

    const updated = await caller.outcome.update({ projectId: project.id, outcomeId: tracked.id, currentValue: 89, status: "MEASURING", notes: "  Week 2  " });
    expect(updated).toMatchObject({ status: "MEASURING", currentValue: 89, notes: "Week 2", progress: 0.6 });
    const cleared = await caller.outcome.update({ projectId: project.id, outcomeId: tracked.id, notes: null });
    expect(cleared.notes).toBeNull();
    // Tracking the same recommendation again updates the same row.
    await caller.outcome.track({ projectId: project.id, recommendationId: rec.id, currentValue: 95, status: "MEASURED" });
    expect(await prisma.outcomeTracking.count({ where: { recommendationId: rec.id } })).toBe(1);

    const list = await callerFor(viewer).outcome.getOutcomes({ projectId: project.id, status: "MEASURED" });
    expect(list.items).toEqual([expect.objectContaining({ id: tracked.id, progress: 1, recommendation: expect.objectContaining({ title: rec.title }) })]);
    expect(await prisma.domainEvent.count({ where: { type: "outcome.updated" } })).toBe(4);

    await expect(callerFor(viewer).outcome.update({ projectId: project.id, outcomeId: tracked.id, currentValue: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(viewer).outcome.track({ projectId: project.id, recommendationId: rec.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(outsider).outcome.getOutcomes({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).outcome.getLearnings({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects recommendations and outcomes from another project", async () => {
    const { owner, project } = await setupTeam();
    const other = await setupTeam();
    const foreignRec = await seedRecommendation(other.project.id);
    const foreignOutcome = await prisma.outcomeTracking.create({ data: { recommendationId: foreignRec.id, status: "SHIPPED" } });
    const caller = callerFor(owner);
    await expect(caller.outcome.track({ projectId: project.id, recommendationId: foreignRec.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.outcome.update({ projectId: project.id, outcomeId: foreignOutcome.id, currentValue: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.outcome.addDecisionLog({ projectId: project.id, decision: "d", reasoning: "r", recommendationId: foreignRec.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.outcomeTracking.findUniqueOrThrow({ where: { id: foreignOutcome.id } })).currentValue).toBeNull();
  });
});

describe("decision log", () => {
  it("requires reasoning and only accepts http(s) evidence links", async () => {
    const { member, viewer, outsider, project } = await setupTeam();
    const caller = callerFor(member);
    await expect(caller.outcome.addDecisionLog({ projectId: project.id, decision: "Ship it", reasoning: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "ftp://files.example.com/x", "https://user:pw@example.com/", "not a url", "//example.com/x"]) {
      await expect(caller.outcome.addDecisionLog({ projectId: project.id, decision: "d", reasoning: "r", evidenceLinks: [bad] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await prisma.decisionLog.count()).toBe(0);

    const rec = await seedRecommendation(project.id);
    const saved = await caller.outcome.addDecisionLog({
      projectId: project.id,
      decision: "Prioritize async exports",
      reasoning: "Top theme by evidence; blocks enterprise renewals.",
      evidenceLinks: ["https://docs.example.com/interviews", "http://wiki.example.com/x", "https://docs.example.com/interviews"],
      recommendationId: rec.id,
    });
    expect(saved.evidenceLinks).toEqual(["https://docs.example.com/interviews", "http://wiki.example.com/x"]);
    const stored = await prisma.decisionLog.findUniqueOrThrow({ where: { id: saved.id } });
    expect(stored).toMatchObject({ evidenceLinks: ["https://docs.example.com/interviews", "http://wiki.example.com/x"], recommendationId: rec.id, userId: member.id });

    await caller.outcome.addDecisionLog({ projectId: project.id, decision: "Second", reasoning: "Because" });
    const page1 = await callerFor(viewer).outcome.getDecisionLog({ projectId: project.id, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await callerFor(viewer).outcome.getDecisionLog({ projectId: project.id, limit: 1, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(page2.nextCursor).toBeNull();

    await expect(callerFor(viewer).outcome.addDecisionLog({ projectId: project.id, decision: "d", reasoning: "r" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(outsider).outcome.getDecisionLog({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(viewer).outcome.updateDecisionOutcome({ projectId: project.id, decisionId: saved.id, outcome: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.outcome.updateDecisionOutcome({ projectId: project.id, decisionId: saved.id, outcome: "Renewals saved" })).resolves.toMatchObject({ outcome: "Renewals saved" });
  });

  it("validates URLs with a scheme allowlist", () => {
    expect(isSafeHttpUrl("https://example.com")).toBe(true);
    expect(isSafeHttpUrl("http://example.com/a?b=c")).toBe(true);
    expect(isSafeHttpUrl("JAVASCRIPT:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("vbscript:msgbox")).toBe(false);
    expect(isSafeHttpUrl("mailto:a@b.co")).toBe(false);
  });
});

describe("learning engine", () => {
  async function seedMeasured(projectId: string, impact: "HIGH" | "LOW", confidence: number, met: boolean, title: string) {
    const rec = await seedRecommendation(projectId, { impact, confidence, status: "IMPLEMENTED", title });
    await prisma.outcomeTracking.create({
      data: { recommendationId: rec.id, status: "MEASURED", metricName: "m", baselineValue: 10, targetValue: 20, currentValue: met ? 22 : 11 },
    });
    return rec;
  }

  it("summarizes what performed well and feeds scoring and generation context", async () => {
    const { owner, project } = await setupTeam();
    for (let i = 0; i < 3; i++) await seedMeasured(project.id, "HIGH", 0.9, true, `High win ${i}`);
    for (let i = 0; i < 3; i++) await seedMeasured(project.id, "LOW", 0.4, false, `Low miss ${i}`);
    // Not measured yet: counted as tracked only.
    const pending = await seedRecommendation(project.id, { status: "IMPLEMENTED" });
    await prisma.outcomeTracking.create({ data: { recommendationId: pending.id, status: "SHIPPED" } });

    const summary = await computeLearningSummary(project.id);
    expect(summary).toMatchObject({ tracked: 7, measured: 6, overall: { met: 3, successRate: 0.5 } });
    expect(summary.byImpact).toEqual([
      expect.objectContaining({ key: "HIGH", measured: 3, met: 3, successRate: 1 }),
      expect.objectContaining({ key: "LOW", measured: 3, met: 0, successRate: 0 }),
    ]);
    expect(summary.topPerformers).toHaveLength(3);
    expect(summary.underperformers).toHaveLength(3);
    expect(summary.insights.join(" ")).toContain("High impact recommendations performed best");

    const high = scoreAdjustment(summary, { impact: "HIGH", confidence: 0.9 });
    const low = scoreAdjustment(summary, { impact: "LOW", confidence: 0.3 });
    expect(high).toBeGreaterThan(1);
    expect(low).toBeLessThan(1);
    expect(high).toBeLessThanOrEqual(1.2);
    expect(low).toBeGreaterThanOrEqual(0.8);

    const context = await getLearningContext(project.id);
    expect(context).toContain("High impact: 3/3 met target");
    expect(context).toContain("Low impact: 0/3 met target");

    const viaApi = await callerFor(owner).outcome.getLearnings({ projectId: project.id });
    expect(viaApi.context).toBe(context);
    expect(viaApi.measured).toBe(6);
  });

  it("does not adjust scores without enough measured outcomes", async () => {
    const { project } = await setupTeam();
    await seedMeasured(project.id, "HIGH", 0.9, true, "Only one");
    const summary = await computeLearningSummary(project.id);
    expect(scoreAdjustment(summary, { impact: "HIGH", confidence: 0.9 })).toBe(1);
    expect(await getLearningContext((await setupTeam()).project.id)).toBeNull();
  });

  it("computes direction-aware progress", () => {
    expect(computeProgress({ baselineValue: 10, currentValue: 15, targetValue: 20 })).toBe(0.5);
    expect(computeProgress({ baselineValue: 100, currentValue: 70, targetValue: 50 })).toBe(0.6); // lower is better
    expect(computeProgress({ baselineValue: 10, currentValue: 5, targetValue: 20 })).toBe(-0.5);
    expect(computeProgress({ baselineValue: 10, currentValue: null, targetValue: 20 })).toBeNull();
  });
});
