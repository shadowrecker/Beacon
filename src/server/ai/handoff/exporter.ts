/**
 * Engineering handoff export.
 *
 * Reuses the recommendation's stored feature brief (generating and storing it
 * via getOrGenerateBrief when missing), builds the handoff document, and for
 * Jira/Linear creates the issue through the org's own integration
 * (createJiraIssue / createLinearIssue with the project's orgId, resolved
 * server-side).
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { NonRetryableError } from "@/server/jobs/worker";
import { getOrGenerateBrief } from "@/server/ai/brief";
import { createJiraIssue, createLinearIssue } from "@/server/integrations/outbound";
import { buildHandoffDocument, type HandoffDocument } from "./document";

export const HANDOFF_TARGETS = ["MARKDOWN", "JIRA", "LINEAR"] as const;
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

/** JobRun.input for kind HANDOFF_EXPORT. */
export const handoffRunInputSchema = z.object({
  recommendationId: z.string().min(1).max(64),
  target: z.enum(["JIRA", "LINEAR"]),
  jiraProjectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,9}$/).optional(),
  linearTeamId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/).optional(),
});
export type HandoffRunInput = z.infer<typeof handoffRunInputSchema>;

/** JobRun.output for kind HANDOFF_EXPORT. */
export const handoffRunOutputSchema = z.object({
  target: z.enum(["JIRA", "LINEAR"]),
  issueKey: z.string(),
  url: z.string(),
  title: z.string(),
  exportedAt: z.string(),
});
export type HandoffRunOutput = z.infer<typeof handoffRunOutputSchema>;

/** Build the handoff document for a recommendation in an (authorized) project. */
export async function prepareHandoff(target: { recommendationId: string; projectId: string; orgId: string }): Promise<HandoffDocument> {
  const rec = await prisma.recommendation.findFirst({
    where: { id: target.recommendationId, projectId: target.projectId },
    select: { id: true, title: true, description: true, impact: true, confidence: true, segments: true, project: { select: { name: true, orgId: true } } },
  });
  if (!rec || rec.project.orgId !== target.orgId) throw new NonRetryableError("Recommendation not found");
  const { brief } = await getOrGenerateBrief(target);
  return buildHandoffDocument({
    recommendation: { id: rec.id, title: rec.title, description: rec.description, impact: rec.impact, confidence: rec.confidence, segments: rec.segments },
    projectName: rec.project.name,
    brief,
  });
}

/** Create the tracker issue for a prepared document. */
export async function pushHandoff(orgId: string, input: HandoffRunInput, doc: HandoffDocument): Promise<HandoffRunOutput> {
  const exportedAt = new Date().toISOString();
  if (input.target === "JIRA") {
    const issue = await createJiraIssue(orgId, {
      summary: doc.title,
      description: doc.plainText,
      ...(input.jiraProjectKey ? { projectKey: input.jiraProjectKey } : {}),
    });
    return { target: "JIRA", issueKey: issue.key, url: issue.url, title: doc.title, exportedAt };
  }
  const issue = await createLinearIssue(orgId, {
    title: doc.title,
    description: doc.markdown,
    ...(input.linearTeamId ? { teamId: input.linearTeamId } : {}),
  });
  return { target: "LINEAR", issueKey: issue.identifier, url: issue.url, title: doc.title, exportedAt };
}
