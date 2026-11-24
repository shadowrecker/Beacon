/**
 * Read helpers for synthesis results, shared by features that build on themes
 * (gap analysis, correlation, presentations, coach, handoff).
 */
import { prisma, type DbClient } from "@/lib/db";

export interface ThemeSummary {
  id: string;
  name: string;
  description: string;
  sentiment: string;
  confidenceScore: number;
  citationCount: number;
  sampleQuotes: string[];
}

/** Themes of the most recent READY synthesis for a project (empty if none). */
export async function getLatestThemes(projectId: string, opts: { limit?: number; quotesPerTheme?: number } = {}, db: DbClient = prisma): Promise<{ synthesisId: string | null; themes: ThemeSummary[] }> {
  const synthesis = await db.synthesis.findFirst({
    where: { projectId, status: "READY" },
    orderBy: { completedAt: "desc" },
    select: { id: true },
  });
  if (!synthesis) return { synthesisId: null, themes: [] };
  const themes = await db.theme.findMany({
    where: { synthesisId: synthesis.id },
    orderBy: { confidenceScore: "desc" },
    take: opts.limit ?? 50,
    select: {
      id: true,
      name: true,
      description: true,
      sentiment: true,
      confidenceScore: true,
      _count: { select: { citations: true } },
      citations: { take: opts.quotesPerTheme ?? 3, orderBy: { relevanceScore: "desc" }, select: { quote: true } },
    },
  });
  return {
    synthesisId: synthesis.id,
    themes: themes.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      sentiment: t.sentiment,
      confidenceScore: t.confidenceScore,
      citationCount: t._count.citations,
      sampleQuotes: t.citations.map((c) => c.quote),
    })),
  };
}
