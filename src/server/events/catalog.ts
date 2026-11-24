/**
 * Domain event catalog. Every event a feature can emit is declared here with its
 * payload schema. Workflows (trigger types), webhooks (subscribable events) and
 * notifications all key off these names.
 */
import { z } from "zod";

const id = z.string().min(1);

export const EVENTS = {
  "document.uploaded": z.object({ documentId: id, title: z.string(), source: z.string() }),
  "document.ready": z.object({ documentId: id, title: z.string(), chunkCount: z.number().int() }),
  "document.failed": z.object({ documentId: id, title: z.string(), error: z.string() }),
  "synthesis.completed": z.object({ synthesisId: id, themeCount: z.number().int() }),
  "synthesis.failed": z.object({ synthesisId: id, error: z.string() }),
  "theme.detected": z.object({
    synthesisId: id,
    themeId: id,
    name: z.string(),
    sentiment: z.string(),
    confidence: z.number(),
  }),
  "recommendation.created": z.object({
    recommendationId: id,
    title: z.string(),
    impact: z.string(),
    confidence: z.number(),
  }),
  "recommendation.status_changed": z.object({
    recommendationId: id,
    title: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  "gap.detected": z.object({ gapAnalysisId: id, roadmapId: id, gapCount: z.number().int() }),
  "correlation.found": z.object({ correlationId: id, themeId: id, featureName: z.string(), score: z.number() }),
  "competitor.updated": z.object({ competitorId: id, updateId: id, type: z.string(), title: z.string() }),
  "sentiment.alert": z.object({ alertId: id, type: z.string(), severity: z.string(), title: z.string() }),
  "presentation.ready": z.object({ presentationId: id, title: z.string() }),
  "voice.ready": z.object({ recordingId: id, documentId: id.nullable() }),
  "integration.synced": z.object({ integrationId: id, provider: z.string(), records: z.number().int() }),
  "integration.failed": z.object({ integrationId: id, provider: z.string(), error: z.string() }),
  "comment.created": z.object({
    commentId: id,
    targetType: z.string(),
    targetId: id,
    mentionedUserIds: z.array(id),
  }),
  "member.joined": z.object({ userId: id, role: z.string() }),
  "member.removed": z.object({ userId: id }),
  "outcome.updated": z.object({ outcomeId: id, recommendationId: id, status: z.string() }),
  "knowledge.extracted": z.object({ documentId: id, entityCount: z.number().int(), relationCount: z.number().int() }),
} as const;

export type EventType = keyof typeof EVENTS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENTS)[T]>;
export const EVENT_TYPES = Object.keys(EVENTS) as EventType[];

/** Events that external webhook subscribers may receive (public contract). */
export const WEBHOOK_EVENTS: EventType[] = [
  "document.ready",
  "document.failed",
  "synthesis.completed",
  "theme.detected",
  "recommendation.created",
  "recommendation.status_changed",
  "gap.detected",
  "competitor.updated",
  "sentiment.alert",
  "presentation.ready",
  "integration.synced",
  "integration.failed",
];

/**
 * Mapping from the legacy WorkflowEvent enum (stored in Workflow.trigger.event) to
 * domain events, so existing workflow definitions keep working.
 */
export const WORKFLOW_TRIGGER_EVENTS: Record<string, EventType> = {
  THEME_DETECTED: "theme.detected",
  RECOMMENDATION_GENERATED: "recommendation.created",
  SYNTHESIS_COMPLETED: "synthesis.completed",
  COMPETITOR_UPDATE: "competitor.updated",
  GAP_DETECTED: "gap.detected",
  CORRELATION_FOUND: "correlation.found",
  DOCUMENT_UPLOADED: "document.uploaded",
};
