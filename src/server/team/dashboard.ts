/**
 * Org-wide dashboard and cross-project themes. All figures are computed from
 * the org's own rows; nothing is estimated or generated.
 */
import { Prisma, type Sentiment } from "@prisma/client";
import type { DbClient } from "@/lib/db";
import { displayName } from "./format";

const DAY = 24 * 3600_000;

export async function getTeamDashboard(db: DbClient, orgId: string) {
  const since7 = new Date(Date.now() - 7 * DAY);
  const since30 = new Date(Date.now() - 30 * DAY);
  const inOrg = { project: { orgId } };

  const [
    org,
    members,
    projects,
    documents,
    readyDocuments,
    syntheses,
    recommendationsByStatus,
    activityLast7Days,
    recentSyntheses,
    topRecommendations,
    activeMembers,
  ] = await Promise.all([
    db.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, plan: true, isPersonal: true } }),
    db.orgMember.count({ where: { orgId, joinedAt: { not: null } } }),
    db.project.count({ where: { orgId } }),
    db.document.count({ where: inOrg }),
    db.document.count({ where: { ...inOrg, status: "READY" } }),
    db.synthesis.count({ where: { ...inOrg, status: "READY" } }),
    db.recommendation.groupBy({ by: ["status"], where: inOrg, _count: { _all: true } }),
    db.teamActivity.count({ where: { orgId, createdAt: { gte: since7 } } }),
    db.synthesis.findMany({
      where: { ...inOrg, status: "READY" },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      take: 5,
      select: {
        id: true,
        type: true,
        completedAt: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
        _count: { select: { themes: true } },
      },
    }),
    db.recommendation.findMany({
      where: { ...inOrg, status: { in: ["DRAFT", "ACCEPTED"] } },
      orderBy: [{ impact: "asc" }, { confidence: "desc" }, { createdAt: "desc" }],
      take: 5,
      select: { id: true, title: true, impact: true, confidence: true, status: true, project: { select: { id: true, name: true } } },
    }),
    db.teamActivity.groupBy({
      by: ["userId"],
      where: { orgId, createdAt: { gte: since30 } },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { userId: "desc" } },
      take: 10,
    }),
  ]);

  const users = activeMembers.length
    ? await db.user.findMany({
        where: { id: { in: activeMembers.map((a) => a.userId) } },
        select: { id: true, name: true, email: true, avatarUrl: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const recCounts = { DRAFT: 0, ACCEPTED: 0, REJECTED: 0, IMPLEMENTED: 0 };
  for (const r of recommendationsByStatus) recCounts[r.status] = r._count._all;

  return {
    org,
    counts: {
      members,
      projects,
      documents,
      readyDocuments,
      syntheses,
      recommendations: recCounts.DRAFT + recCounts.ACCEPTED + recCounts.REJECTED + recCounts.IMPLEMENTED,
      recommendationsByStatus: recCounts,
      activityLast7Days,
    },
    recentSyntheses: recentSyntheses.map((s) => ({
      id: s.id,
      type: s.type,
      completedAt: s.completedAt ?? s.createdAt,
      themeCount: s._count.themes,
      project: s.project,
    })),
    topRecommendations: topRecommendations.map((r) => ({
      id: r.id,
      title: r.title,
      impact: r.impact,
      confidence: r.confidence,
      status: r.status,
      project: r.project,
    })),
    memberActivity: activeMembers.map((a) => {
      const u = userById.get(a.userId);
      return {
        userId: a.userId,
        name: displayName(u),
        avatarUrl: u?.avatarUrl ?? null,
        actions: a._count._all,
        lastActiveAt: a._max.createdAt,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Cross-project themes
// ---------------------------------------------------------------------------

/** Projects considered (most recently updated first) and themes per synthesis. */
export const CROSS_PROJECT_LIMITS = { projects: 200, themesPerSynthesis: 50 } as const;

/** Key used to group themes with the same name across projects. */
export function themeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface CrossProjectTheme {
  key: string;
  name: string;
  projectCount: number;
  citationCount: number;
  avgConfidence: number;
  sentiment: Sentiment;
  sentimentBreakdown: Record<Sentiment, number>;
  projects: Array<{ id: string; name: string; themeId: string; synthesisId: string }>;
}

export async function getCrossProjectThemes(
  db: DbClient,
  orgId: string,
  opts: { minProjects: number; limit: number; cursor?: string | null }
): Promise<{ items: CrossProjectTheme[]; nextCursor: string | null; projectsConsidered: number; projectsSkipped: number }> {
  const [projects, totalProjects] = await Promise.all([
    db.project.findMany({
      where: { orgId },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: CROSS_PROJECT_LIMITS.projects,
      select: { id: true, name: true },
    }),
    db.project.count({ where: { orgId } }),
  ]);
  const empty = { items: [], nextCursor: null, projectsConsidered: projects.length, projectsSkipped: Math.max(0, totalProjects - projects.length) };
  if (projects.length === 0) return empty;

  // Latest READY synthesis per project.
  const latest = await db.$queryRaw<Array<{ id: string; projectId: string }>>`
    SELECT DISTINCT ON ("projectId") id, "projectId"
    FROM syntheses
    WHERE status = 'READY' AND "projectId" IN (${Prisma.join(projects.map((p) => p.id))})
    ORDER BY "projectId", "completedAt" DESC NULLS LAST, "createdAt" DESC`;
  if (latest.length === 0) return empty;

  const themes = await db.$queryRaw<
    Array<{ id: string; synthesisId: string; name: string; sentiment: Sentiment; confidenceScore: number; citations: number }>
  >`
    SELECT t.id, t."synthesisId", t.name, t.sentiment, t."confidenceScore",
           (SELECT count(*)::int FROM citations c WHERE c."themeId" = t.id) AS citations
    FROM (
      SELECT th.*, row_number() OVER (PARTITION BY th."synthesisId" ORDER BY th."confidenceScore" DESC, th.id) AS rn
      FROM themes th
      WHERE th."synthesisId" IN (${Prisma.join(latest.map((l) => l.id))})
    ) t
    WHERE t.rn <= ${CROSS_PROJECT_LIMITS.themesPerSynthesis}`;

  const projectBySynthesis = new Map(latest.map((l) => [l.id, l.projectId]));
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const groups = new Map<
    string,
    { names: Map<string, number>; confidence: number[]; citations: number; sentiments: Record<Sentiment, number>; projects: Map<string, { themeId: string; synthesisId: string }> }
  >();

  for (const t of themes) {
    const key = themeKey(t.name);
    if (!key) continue;
    const projectId = projectBySynthesis.get(t.synthesisId);
    if (!projectId) continue;
    let g = groups.get(key);
    if (!g) {
      g = { names: new Map(), confidence: [], citations: 0, sentiments: { POSITIVE: 0, NEGATIVE: 0, NEUTRAL: 0, MIXED: 0 }, projects: new Map() };
      groups.set(key, g);
    }
    g.names.set(t.name, (g.names.get(t.name) ?? 0) + 1);
    g.confidence.push(Number(t.confidenceScore));
    g.citations += Number(t.citations);
    g.sentiments[t.sentiment] += 1;
    if (!g.projects.has(projectId)) g.projects.set(projectId, { themeId: t.id, synthesisId: t.synthesisId });
  }

  const all: CrossProjectTheme[] = [...groups.entries()]
    .map(([key, g]) => {
      // Most common spelling; ties go to the tidiest (shortest) one.
      const name = [...g.names.entries()].sort((a, b) => b[1] - a[1] || a[0].trim().length - b[0].trim().length || a[0].localeCompare(b[0]))[0][0].trim();
      const sentiment = (Object.entries(g.sentiments) as Array<[Sentiment, number]>).sort((a, b) => b[1] - a[1])[0][0];
      return {
        key,
        name,
        projectCount: g.projects.size,
        citationCount: g.citations,
        avgConfidence: g.confidence.reduce((s, c) => s + c, 0) / g.confidence.length,
        sentiment,
        sentimentBreakdown: g.sentiments,
        projects: [...g.projects.entries()].map(([id, v]) => ({ id, name: projectName.get(id) ?? "", ...v })),
      };
    })
    .filter((t) => t.projectCount >= opts.minProjects)
    .sort((a, b) => b.projectCount - a.projectCount || b.citationCount - a.citationCount || b.avgConfidence - a.avgConfidence || a.key.localeCompare(b.key));

  const start = opts.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10) || 0) : 0;
  const items = all.slice(start, start + opts.limit);
  const next = start + opts.limit;
  return {
    items,
    nextCursor: next < all.length ? String(next) : null,
    projectsConsidered: projects.length,
    projectsSkipped: Math.max(0, totalProjects - projects.length),
  };
}
