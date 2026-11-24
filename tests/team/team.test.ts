import { describe, expect, it } from "vitest";
import type { Sentiment } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { teamCaller, installFakeIdentity } from "./helpers";

installFakeIdentity();

async function synthesis(projectId: string, themes: Array<[string, Sentiment]>, opts: { status?: "READY" | "FAILED"; completedAt?: Date } = {}) {
  const s = await prisma.synthesis.create({
    data: { projectId, type: "THEMES", status: opts.status ?? "READY", completedAt: opts.completedAt ?? new Date() },
  });
  for (const [name, sentiment] of themes) {
    await prisma.theme.create({ data: { synthesisId: s.id, name, description: "d", sentiment, confidenceScore: 0.6 } });
  }
  return s;
}

describe("team.dashboard", () => {
  it("counts the active org's own data only", async () => {
    const owner = await createUser();
    const viewer = await createUser();
    const org = await createOrg(owner);
    await addMember(org.id, viewer, "VIEWER");
    const p1 = await createProject(owner, org.id, "P1");
    await createProject(owner, org.id, "P2");
    await createProject(owner); // personal, not counted
    await prisma.document.create({ data: { projectId: p1.id, title: "d", type: "NOTE", status: "READY" } });
    await synthesis(p1.id, [["A", "NEGATIVE"]]);
    await prisma.recommendation.create({ data: { projectId: p1.id, title: "Do X", description: "d", impact: "HIGH", confidence: 0.9 } });
    await prisma.recommendation.create({
      data: { projectId: p1.id, title: "Done", description: "d", impact: "LOW", confidence: 0.4, status: "IMPLEMENTED" },
    });

    const d = await teamCaller(viewer, org.id).team.dashboard();
    expect(d.counts).toMatchObject({ members: 2, projects: 2, documents: 1, readyDocuments: 1, syntheses: 1, recommendations: 2 });
    expect(d.counts.recommendationsByStatus).toMatchObject({ DRAFT: 1, IMPLEMENTED: 1 });
    expect(d.topRecommendations.map((r) => r.title)).toEqual(["Do X"]);
    expect(d.recentSyntheses[0]).toMatchObject({ themeCount: 1, project: { id: p1.id, name: "P1" } });

    const outsider = await createUser();
    await expect(teamCaller(outsider, org.id).team.dashboard()).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Without a header the caller's personal workspace is used.
    expect((await teamCaller(owner).team.dashboard()).org?.id).toBe(owner.personalOrgId);
  });
});

describe("team.crossProjectThemes", () => {
  it("groups themes from each project's latest READY synthesis across projects", async () => {
    const owner = await createUser();
    const org = await createOrg(owner);
    const a = await createProject(owner, org.id, "Alpha");
    const b = await createProject(owner, org.id, "Beta");
    const c = await createProject(owner, org.id, "Gamma");
    // Alpha: older synthesis is superseded by the latest one.
    await synthesis(a.id, [["Old theme", "NEUTRAL"]], { completedAt: new Date(Date.now() - 86400_000) });
    await synthesis(a.id, [["Pricing confusion", "NEGATIVE"], ["Fast support", "POSITIVE"]]);
    await synthesis(b.id, [["pricing  confusion!", "NEGATIVE"]]);
    await synthesis(c.id, [["Pricing confusion", "MIXED"]], { status: "FAILED" });

    const shared = await teamCaller(owner, org.id).team.crossProjectThemes({});
    expect(shared.items).toHaveLength(1);
    expect(shared.items[0]).toMatchObject({ name: "Pricing confusion", projectCount: 2, sentiment: "NEGATIVE" });
    expect(shared.items[0].projects.map((p) => p.name).sort()).toEqual(["Alpha", "Beta"]);

    const all = await teamCaller(owner, org.id).team.crossProjectThemes({ minProjects: 1, limit: 1 });
    expect(all.items).toHaveLength(1);
    expect(all.nextCursor).toBe("1");
    const rest = await teamCaller(owner, org.id).team.crossProjectThemes({ minProjects: 1, limit: 10, cursor: all.nextCursor });
    expect(rest.items.map((t) => t.name)).toEqual(["Fast support"]);
  });
});

describe("team.activityFeed", () => {
  it("paginates the org's activity and rejects foreign filters", async () => {
    const owner = await createUser({ name: "Owner" });
    const org = await createOrg(owner);
    const project = await createProject(owner, org.id, "Research");
    for (let i = 0; i < 3; i++) {
      await prisma.teamActivity.create({
        data: {
          orgId: org.id,
          userId: owner.id,
          projectId: project.id,
          action: "recommendation.created",
          resourceType: "recommendation",
          resourceId: `rec${i}`,
          metadata: { title: `Rec ${i}`, sourceKey: `k${i}` },
        },
      });
    }
    const other = await createUser();
    const otherProject = await createProject(other);
    await prisma.teamActivity.create({
      data: { orgId: other.personalOrgId, userId: other.id, action: "document.uploaded", resourceType: "document", resourceId: "d", metadata: {} },
    });

    const page = await teamCaller(owner, org.id).team.activityFeed({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].summary).toMatch(/^generated the recommendation "Rec \d"$/);
    const next = await teamCaller(owner, org.id).team.activityFeed({ limit: 2, cursor: page.nextCursor });
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).toBeNull();

    await expect(teamCaller(owner, org.id).team.activityFeed({ projectId: otherProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(teamCaller(owner, org.id).team.activityFeed({ userId: other.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
