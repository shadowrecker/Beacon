/**
 * Facts about a project's product-management practice, read from the database
 * with bounded queries. Used both as the (trusted, computed) part of the coach
 * prompt and directly by coach.getActivityAnalysis (no LLM).
 */
import type { RecommendationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getLatestThemes, type ThemeSummary } from "../../synthesis/queries";
import { activityCounts } from "./activity";

const DAY = 86_400_000;
export const COACH_WINDOW_DAYS = 30;
const STALE_DRAFT_DAYS = 14;

export interface DecisionPatterns {
  accepted: number;
  rejected: number;
  implemented: number;
  drafts: number;
  /** Accepted or implemented, as a share of decided recommendations (null if none decided). */
  acceptanceRate: number | null;
  avgConfidenceAccepted: number | null;
  avgConfidenceRejected: number | null;
  decisionsLogged: number;
  /** Share of logged decisions that cite evidence (null if none logged). */
  decisionsWithEvidenceShare: number | null;
}

export interface IgnoredTheme {
  name: string;
  sentiment: string;
  confidence: number;
  citationCount: number;
}

export interface CoachContext {
  project: { id: string; orgId: string; userId: string; name: string; description: string | null };
  generatedAt: Date;
  counts: {
    documents: number;
    documentsRecent: number;
    documentsFailed: number;
    synthesesRecent: number;
    queriesRecent: number;
    recommendationsRecent: number;
    staleDrafts: number;
    acceptedWithoutOutcome: number;
    outcomesTracked: number;
    openSentimentAlerts: number;
    knowledgeEntities: number;
  };
  latestSynthesisAt: Date | null;
  themes: ThemeSummary[];
  ignoredThemes: IgnoredTheme[];
  decisionPatterns: DecisionPatterns;
  recentRecommendations: Array<{ title: string; status: RecommendationStatus; impact: string; confidence: number; createdAt: Date }>;
  recentDecisions: Array<{ decision: string; hasEvidence: boolean; createdAt: Date }>;
  sentiment: { overallScore: number; riskLevel: string; periodStart: Date; period: string } | null;
  activity: Record<string, number>;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "into", "not", "too", "are", "was", "our", "you", "their", "that", "this", "lack"]);
const tokens = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOPWORDS.has(t));

/** Themes with real support that no recommendation appears to address. */
export function findIgnoredThemes(themes: ThemeSummary[], recommendationTexts: string[]): IgnoredTheme[] {
  const corpus = recommendationTexts.map((t) => new Set(tokens(t)));
  return themes
    .filter((t) => t.confidenceScore >= 0.6 && t.citationCount >= 2)
    .filter((t) => {
      const words = [...new Set(tokens(t.name))];
      if (words.length === 0) return false;
      return !corpus.some((set) => words.filter((w) => set.has(w)).length / words.length >= 0.6);
    })
    .slice(0, 8)
    .map((t) => ({ name: t.name, sentiment: t.sentiment, confidence: t.confidenceScore, citationCount: t.citationCount }));
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

export async function buildCoachContext(projectId: string): Promise<CoachContext | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, orgId: true, userId: true, name: true, description: true },
  });
  if (!project) return null;
  const now = new Date();
  const since = new Date(now.getTime() - COACH_WINDOW_DAYS * DAY);
  const staleBefore = new Date(now.getTime() - STALE_DRAFT_DAYS * DAY);

  const [
    documents,
    documentsRecent,
    documentsFailed,
    synthesesRecent,
    queriesRecent,
    recommendationsRecent,
    staleDrafts,
    acceptedWithoutOutcome,
    outcomesTracked,
    openSentimentAlerts,
    knowledgeEntities,
    latestSynthesis,
    statusGroups,
    confidences,
    recRows,
    decisions,
    decisionsLogged,
    decisionsWithEvidence,
    snapshot,
    latestThemes,
    activity,
  ] = await Promise.all([
    prisma.document.count({ where: { projectId } }),
    prisma.document.count({ where: { projectId, createdAt: { gte: since } } }),
    prisma.document.count({ where: { projectId, status: "FAILED", createdAt: { gte: since } } }),
    prisma.synthesis.count({ where: { projectId, status: "READY", completedAt: { gte: since } } }),
    prisma.query.count({ where: { projectId, createdAt: { gte: since } } }),
    prisma.recommendation.count({ where: { projectId, createdAt: { gte: since } } }),
    prisma.recommendation.count({ where: { projectId, status: "DRAFT", createdAt: { lt: staleBefore } } }),
    prisma.recommendation.count({ where: { projectId, status: { in: ["ACCEPTED", "IMPLEMENTED"] }, outcomeTrackings: { none: {} } } }),
    prisma.outcomeTracking.count({ where: { recommendation: { projectId } } }),
    prisma.sentimentAlert.count({ where: { projectId, status: { in: ["NEW", "ACKNOWLEDGED"] } } }),
    prisma.knowledgeNode_Project.count({ where: { projectId } }),
    prisma.synthesis.findFirst({ where: { projectId, status: "READY" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }),
    prisma.recommendation.groupBy({ by: ["status"], where: { projectId }, _count: { _all: true } }),
    prisma.recommendation.findMany({
      where: { projectId, status: { in: ["ACCEPTED", "IMPLEMENTED", "REJECTED"] } },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { status: true, confidence: true },
    }),
    prisma.recommendation.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { title: true, description: true, status: true, impact: true, confidence: true, createdAt: true },
    }),
    prisma.decisionLog.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { decision: true, evidenceLinks: true, recommendationId: true, createdAt: true },
    }),
    prisma.decisionLog.count({ where: { projectId } }),
    prisma.decisionLog.count({ where: { projectId, OR: [{ evidenceLinks: { isEmpty: false } }, { recommendationId: { not: null } }] } }),
    prisma.sentimentSnapshot.findFirst({
      where: { projectId, customerSegment: "all" },
      orderBy: { periodStart: "desc" },
      select: { overallScore: true, riskLevel: true, periodStart: true, period: true },
    }),
    getLatestThemes(projectId, { limit: 12, quotesPerTheme: 1 }),
    activityCounts(projectId, 14),
  ]);

  const byStatus = new Map(statusGroups.map((g) => [g.status, g._count._all]));
  const accepted = byStatus.get("ACCEPTED") ?? 0;
  const implemented = byStatus.get("IMPLEMENTED") ?? 0;
  const rejected = byStatus.get("REJECTED") ?? 0;
  const decided = accepted + implemented + rejected;

  const decisionPatterns: DecisionPatterns = {
    accepted,
    rejected,
    implemented,
    drafts: byStatus.get("DRAFT") ?? 0,
    acceptanceRate: decided > 0 ? Math.round(((accepted + implemented) / decided) * 100) / 100 : null,
    avgConfidenceAccepted: avg(confidences.filter((c) => c.status !== "REJECTED").map((c) => c.confidence)),
    avgConfidenceRejected: avg(confidences.filter((c) => c.status === "REJECTED").map((c) => c.confidence)),
    decisionsLogged,
    decisionsWithEvidenceShare: decisionsLogged > 0 ? Math.round((decisionsWithEvidence / decisionsLogged) * 100) / 100 : null,
  };

  return {
    project,
    generatedAt: now,
    counts: {
      documents,
      documentsRecent,
      documentsFailed,
      synthesesRecent,
      queriesRecent,
      recommendationsRecent,
      staleDrafts,
      acceptedWithoutOutcome,
      outcomesTracked,
      openSentimentAlerts,
      knowledgeEntities,
    },
    latestSynthesisAt: latestSynthesis?.completedAt ?? null,
    themes: latestThemes.themes,
    ignoredThemes: findIgnoredThemes(
      latestThemes.themes,
      recRows.map((r) => `${r.title} ${r.description.slice(0, 600)}`)
    ),
    decisionPatterns,
    recentRecommendations: recRows.slice(0, 10).map((r) => ({ title: r.title.slice(0, 200), status: r.status, impact: r.impact, confidence: r.confidence, createdAt: r.createdAt })),
    recentDecisions: decisions.map((d) => ({
      decision: d.decision.slice(0, 300),
      hasEvidence: d.evidenceLinks.length > 0 || !!d.recommendationId,
      createdAt: d.createdAt,
    })),
    sentiment: snapshot,
    activity,
  };
}
