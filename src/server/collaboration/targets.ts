/**
 * Comment targets. A comment's (targetType, targetId) must belong to the
 * comment's project; every lookup is scoped by projectId so a foreign ID from
 * another project or org is reported as NOT_FOUND.
 */
import type { CommentTargetType } from "@prisma/client";
import type { DbClient } from "@/lib/db";

export interface CommentTarget {
  type: CommentTargetType;
  id: string;
  /** Short human label ("Onboarding friction", "Q3 pricing decision"). */
  label: string;
}

function excerpt(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const SYNTHESIS_LABELS: Record<string, string> = {
  THEMES: "Theme synthesis",
  PAIN_POINTS: "Pain point synthesis",
  FEATURE_REQUESTS: "Feature request synthesis",
  FULL: "Full synthesis",
};

/** Find a target inside `projectId`, or null when it doesn't exist there. */
export async function findCommentTarget(
  db: DbClient,
  projectId: string,
  type: CommentTargetType,
  id: string
): Promise<CommentTarget | null> {
  switch (type) {
    case "THEME": {
      const row = await db.theme.findFirst({ where: { id, synthesis: { projectId } }, select: { name: true } });
      return row ? { type, id, label: excerpt(row.name) } : null;
    }
    case "RECOMMENDATION": {
      const row = await db.recommendation.findFirst({ where: { id, projectId }, select: { title: true } });
      return row ? { type, id, label: excerpt(row.title) } : null;
    }
    case "SYNTHESIS": {
      const row = await db.synthesis.findFirst({ where: { id, projectId }, select: { type: true } });
      return row ? { type, id, label: SYNTHESIS_LABELS[row.type] ?? "Synthesis" } : null;
    }
    case "DOCUMENT": {
      const row = await db.document.findFirst({ where: { id, projectId }, select: { title: true } });
      return row ? { type, id, label: excerpt(row.title) } : null;
    }
    case "DECISION": {
      const row = await db.decisionLog.findFirst({ where: { id, projectId }, select: { decision: true } });
      return row ? { type, id, label: excerpt(row.decision) } : null;
    }
  }
}
