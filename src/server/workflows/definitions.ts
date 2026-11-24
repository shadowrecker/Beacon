/**
 * Workflow definitions: triggers, conditions and per-action parameter schemas.
 *
 * This module is isomorphic (zod and the event catalog only), so the builder UI
 * renders its forms and validates input from exactly the schemas the server
 * enforces at create/update time and again at run time.
 *
 * Security rules encoded here (confused-deputy protections):
 * - Every action schema is `.strict()`: unknown keys such as `orgId`,
 *   `credentials`, `apiToken`, `from`, `html` or free-form `recipients` addresses
 *   are rejected. Tenant context and credentials are always derived server-side
 *   from the workflow's project.
 * - Recipients are org members only (user IDs or `role:` groups), never email
 *   addresses. Provider identifiers (Slack channel, Jira project key, Linear team)
 *   are validated against strict patterns; hosts are never user-supplied.
 * - The `matches` (regular expression) condition operator was removed: user
 *   regexes are a ReDoS vector. Use `contains` or `in` instead.
 */
import { z } from "zod";
import { EVENTS, WORKFLOW_TRIGGER_EVENTS, type EventType } from "../events/catalog";

/** Events deeper than this in a workflow-caused chain never trigger workflows. */
export const MAX_CAUSATION_DEPTH = 3;
/** Per-workflow cap on event-triggered runs per hour (loop and cost guard). */
export const WORKFLOW_RUNS_PER_HOUR = 30;
export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 10;

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const TRIGGER_EVENTS = {
  "document.uploaded": { label: "Document uploaded", description: "A document was added to the project." },
  "document.ready": { label: "Document processed", description: "A document finished processing and is searchable." },
  "document.failed": { label: "Document failed", description: "A document could not be processed." },
  "synthesis.completed": { label: "Synthesis completed", description: "A synthesis run finished." },
  "synthesis.failed": { label: "Synthesis failed", description: "A synthesis run failed." },
  "theme.detected": { label: "Theme detected", description: "A synthesis surfaced a theme." },
  "recommendation.created": { label: "Recommendation created", description: "A new recommendation was generated." },
  "recommendation.status_changed": { label: "Recommendation status changed", description: "A recommendation was accepted, rejected or implemented." },
  "gap.detected": { label: "Roadmap gaps detected", description: "A gap analysis found gaps between the roadmap and feedback." },
  "correlation.found": { label: "Correlation found", description: "Analytics correlated a theme with feature usage." },
  "competitor.updated": { label: "Competitor update", description: "A tracked competitor changed something." },
  "sentiment.alert": { label: "Sentiment alert", description: "Customer sentiment crossed an alert threshold." },
  "presentation.ready": { label: "Presentation ready", description: "A generated presentation is ready." },
  "voice.ready": { label: "Voice recording processed", description: "A voice recording was transcribed and analyzed." },
  "integration.synced": { label: "Integration synced", description: "An integration finished syncing records." },
  "integration.failed": { label: "Integration sync failed", description: "An integration sync failed." },
  "knowledge.extracted": { label: "Knowledge extracted", description: "Entities and relations were extracted from a document." },
  "outcome.updated": { label: "Outcome updated", description: "A tracked outcome for a recommendation changed." },
} as const satisfies Partial<Record<EventType, { label: string; description: string }>>;

export type TriggerEvent = keyof typeof TRIGGER_EVENTS;
export const TRIGGER_EVENT_TYPES = Object.keys(TRIGGER_EVENTS) as TriggerEvent[];

/** Map a stored trigger event (legacy enum name or domain event) to a domain event. */
export function normalizeTriggerEvent(raw: unknown): TriggerEvent | null {
  if (typeof raw !== "string") return null;
  const mapped = WORKFLOW_TRIGGER_EVENTS[raw] ?? raw;
  return mapped in TRIGGER_EVENTS ? (mapped as TriggerEvent) : null;
}

export interface EventField {
  name: string;
  type: "string" | "number" | "boolean" | "array";
}

/** Payload fields of an event, usable in conditions and message placeholders. */
export function eventFields(event: TriggerEvent): EventField[] {
  const schema = EVENTS[event] as unknown as z.ZodObject<Record<string, z.ZodType>>;
  return Object.entries(schema.shape).map(([name, s]) => {
    const def = (s as { def?: { type?: string; innerType?: { def?: { type?: string } } } }).def;
    const t = def?.type === "nullable" ? def.innerType?.def?.type : def?.type;
    const type: EventField["type"] = t === "number" ? "number" : t === "boolean" ? "boolean" : t === "array" ? "array" : "string";
    return { name, type };
  });
}

/**
 * Trigger/action pairs that would feed themselves: a synthesis run emits
 * synthesis.* and theme.* events (and drives recommendation generation), so a
 * workflow triggered by those events may not start another synthesis.
 */
export const SYNTHESIS_DOWNSTREAM_EVENTS: ReadonlySet<TriggerEvent> = new Set<TriggerEvent>([
  "synthesis.completed",
  "synthesis.failed",
  "theme.detected",
  "recommendation.created",
]);

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const CONDITION_OPERATORS = ["eq", "neq", "gt", "lt", "contains", "in", "exists"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "is greater than",
  lt: "is less than",
  contains: "contains",
  in: "is one of",
  exists: "is present",
};

const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]{0,63}(\.[A-Za-z0-9_]{1,64}){0,4}$/;
const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const conditionSchema = z
  .object({
    field: z.string().min(1, "Choose a field").max(100).regex(FIELD_PATH, "Field must be a payload field name, e.g. confidence"),
    operator: z.enum(CONDITION_OPERATORS, {
      error: (issue) =>
        issue.input === "matches"
          ? "The 'matches' (regular expression) operator is not supported. Use 'contains' or 'is one of'."
          : "Unknown operator",
    }),
    value: z.union([scalar, z.array(z.union([z.string().max(200), z.number().finite()])).max(50)]).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const v = c.value;
    switch (c.operator) {
      case "in":
        if (!Array.isArray(v) || v.length === 0) ctx.addIssue({ code: "custom", path: ["value"], message: "Provide at least one value" });
        break;
      case "gt":
      case "lt":
        if (typeof v !== "number") ctx.addIssue({ code: "custom", path: ["value"], message: "Provide a number" });
        break;
      case "contains":
        if (typeof v !== "string" || v.length === 0) ctx.addIssue({ code: "custom", path: ["value"], message: "Provide text to look for" });
        break;
      case "eq":
      case "neq":
        if (v === undefined || Array.isArray(v)) ctx.addIssue({ code: "custom", path: ["value"], message: "Provide a single value" });
        break;
      case "exists":
        if (v !== undefined && typeof v !== "boolean") ctx.addIssue({ code: "custom", path: ["value"], message: "Use true or false" });
        break;
    }
  });

export type WorkflowCondition = z.infer<typeof conditionSchema>;

export const triggerSchema = z
  .object({
    event: z
      .string()
      .max(64)
      .refine((e) => normalizeTriggerEvent(e) !== null, "Choose a supported trigger event"),
    conditions: z.array(conditionSchema).max(MAX_CONDITIONS, `At most ${MAX_CONDITIONS} conditions`).default([]),
  })
  .strict();

export type WorkflowTriggerInput = z.input<typeof triggerSchema>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Same pattern as the Slack sender (channel ID or #name). */
const SLACK_CHANNEL = /^[CGD][A-Z0-9]{6,}$|^#[a-z0-9_-]{1,80}$/;
const ID = /^[A-Za-z0-9_-]{10,40}$/;
const PLACEHOLDER = /\{\{\s*([^}]*?)\s*\}\}/g;
const PLACEHOLDER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

export const ROLE_GROUPS = ["role:OWNER", "role:ADMIN", "role:MEMBER", "role:ALL"] as const;
export type RoleGroup = (typeof ROLE_GROUPS)[number];
export const ROLE_GROUP_LABELS: Record<RoleGroup, string> = {
  "role:OWNER": "Owners",
  "role:ADMIN": "Admins and owners",
  "role:MEMBER": "Members, admins and owners (no viewers)",
  "role:ALL": "Everyone in the workspace",
};

function template(max: number, title: string) {
  return z
    .string()
    .trim()
    .min(1, `${title} is required`)
    .max(max, `${title} must be at most ${max} characters`)
    .superRefine((s, ctx) => {
      for (const m of s.matchAll(PLACEHOLDER)) {
        if (!PLACEHOLDER_NAME.test(m[1])) {
          ctx.addIssue({ code: "custom", message: `Invalid placeholder {{${m[1].slice(0, 40)}}}` });
          return;
        }
      }
    })
    .meta({ title, widget: "template", description: "Plain text. Placeholders like {{title}}, {{project}}, {{event}} and {{link}} are filled from the event." });
}

const recommendationId = z
  .string()
  .regex(ID, "Invalid recommendation")
  .optional()
  .meta({
    title: "Recommendation",
    widget: "recommendation",
    description: "Defaults to the recommendation in the triggering event. Must belong to this workflow's project.",
  });

const recipient = z.union([
  z.enum(ROLE_GROUPS),
  z.string().regex(ID, "Recipients must be workspace members or a role group"),
]);

export const ACTION_PARAM_SCHEMAS = {
  NOTIFY_SLACK: z
    .object({
      channel: z
        .string()
        .regex(SLACK_CHANNEL, "Use a channel like #product-insights or a channel ID")
        .optional()
        .meta({ title: "Channel", description: "Leave empty to use the Slack integration's default channel." }),
      message: template(1000, "Message"),
    })
    .strict(),
  NOTIFY_EMAIL: z
    .object({
      recipients: z
        .array(recipient)
        .min(1, "Choose at least one recipient")
        .max(20)
        .meta({ title: "Recipients", widget: "recipients", description: "Workspace members or role groups. External addresses are not allowed." }),
      subject: template(150, "Subject"),
      message: template(2000, "Message"),
    })
    .strict(),
  ALERT_TEAM: z
    .object({
      audience: z.enum(ROLE_GROUPS).default("role:ADMIN").meta({ title: "Audience", widget: "roleGroup" }),
      priority: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM").meta({ title: "Priority" }),
      title: template(150, "Title"),
      message: template(1000, "Message"),
    })
    .strict(),
  ASSIGN_USER: z
    .object({
      userId: z.string().regex(ID, "Choose a workspace member").meta({ title: "Assignee", widget: "member" }),
      note: template(500, "Note").optional(),
    })
    .strict(),
  ADD_TO_ROADMAP: z
    .object({
      roadmapId: z
        .string()
        .regex(ID, "Invalid roadmap")
        .optional()
        .meta({ title: "Roadmap", widget: "roadmap", description: "Defaults to the project's most recent roadmap." }),
      recommendationId,
      priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2").meta({ title: "Priority" }),
      quarter: z
        .string()
        .regex(/^Q[1-4] \d{4}$/, "Use the form Q3 2026")
        .optional()
        .meta({ title: "Quarter", description: "For example Q3 2026." }),
    })
    .strict(),
  EXPORT_TO_JIRA: z
    .object({
      recommendationId,
      projectKey: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{1,9}$/, "Jira project keys look like PROD")
        .optional()
        .meta({ title: "Jira project key", description: "Leave empty to use the Jira integration's default project." }),
      issueType: z.enum(["Task", "Story", "Bug", "Epic"]).default("Task").meta({ title: "Issue type" }),
    })
    .strict(),
  EXPORT_TO_LINEAR: z
    .object({
      recommendationId,
      teamId: z
        .string()
        .regex(/^[a-zA-Z0-9-]{1,64}$/, "Invalid Linear team ID")
        .optional()
        .meta({ title: "Linear team ID", description: "Leave empty to use the Linear integration's default team." }),
    })
    .strict(),
  CREATE_BRIEF: z
    .object({
      recommendationId,
      regenerate: z.boolean().default(false).meta({ title: "Regenerate existing briefs" }),
    })
    .strict(),
  RUN_SYNTHESIS: z
    .object({
      type: z.enum(["THEMES", "PAIN_POINTS", "FEATURE_REQUESTS", "FULL"]).default("FULL").meta({ title: "Synthesis type" }),
    })
    .strict(),
} as const;

export type ActionType = keyof typeof ACTION_PARAM_SCHEMAS;
export const ACTION_TYPES = Object.keys(ACTION_PARAM_SCHEMAS) as ActionType[];
export type ActionParams<T extends ActionType> = z.infer<(typeof ACTION_PARAM_SCHEMAS)[T]>;

export const ACTION_META: Record<ActionType, { label: string; description: string; requires?: "SLACK" | "JIRA" | "LINEAR" }> = {
  NOTIFY_SLACK: { label: "Post to Slack", description: "Post a message to your connected Slack workspace.", requires: "SLACK" },
  NOTIFY_EMAIL: { label: "Email workspace members", description: "Notify members in-app and by email." },
  ALERT_TEAM: { label: "Alert the team", description: "Send an in-app alert to a group of members." },
  ASSIGN_USER: { label: "Assign to a member", description: "Notify a member that the item was assigned to them." },
  ADD_TO_ROADMAP: { label: "Add to roadmap", description: "Add the recommendation to one of this project's roadmaps." },
  EXPORT_TO_JIRA: { label: "Create Jira issue", description: "Create an issue from the recommendation in your connected Jira.", requires: "JIRA" },
  EXPORT_TO_LINEAR: { label: "Create Linear issue", description: "Create an issue from the recommendation in your connected Linear.", requires: "LINEAR" },
  CREATE_BRIEF: { label: "Generate brief", description: "Generate a feature brief for the recommendation." },
  RUN_SYNTHESIS: { label: "Run synthesis", description: "Start a new synthesis of this project's feedback." },
};

/** Actions that operate on a recommendation (from the event or `recommendationId`). */
export const RECOMMENDATION_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  "ADD_TO_ROADMAP",
  "EXPORT_TO_JIRA",
  "EXPORT_TO_LINEAR",
  "CREATE_BRIEF",
]);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NOTIFY_SLACK"), params: ACTION_PARAM_SCHEMAS.NOTIFY_SLACK }).strict(),
  z.object({ type: z.literal("NOTIFY_EMAIL"), params: ACTION_PARAM_SCHEMAS.NOTIFY_EMAIL }).strict(),
  z.object({ type: z.literal("ALERT_TEAM"), params: ACTION_PARAM_SCHEMAS.ALERT_TEAM }).strict(),
  z.object({ type: z.literal("ASSIGN_USER"), params: ACTION_PARAM_SCHEMAS.ASSIGN_USER }).strict(),
  z.object({ type: z.literal("ADD_TO_ROADMAP"), params: ACTION_PARAM_SCHEMAS.ADD_TO_ROADMAP }).strict(),
  z.object({ type: z.literal("EXPORT_TO_JIRA"), params: ACTION_PARAM_SCHEMAS.EXPORT_TO_JIRA }).strict(),
  z.object({ type: z.literal("EXPORT_TO_LINEAR"), params: ACTION_PARAM_SCHEMAS.EXPORT_TO_LINEAR }).strict(),
  z.object({ type: z.literal("CREATE_BRIEF"), params: ACTION_PARAM_SCHEMAS.CREATE_BRIEF }).strict(),
  z.object({ type: z.literal("RUN_SYNTHESIS"), params: ACTION_PARAM_SCHEMAS.RUN_SYNTHESIS }).strict(),
]);

export type WorkflowAction = z.infer<typeof actionSchema>;
export type WorkflowActionInput = z.input<typeof actionSchema>;

export const actionsSchema = z.array(actionSchema).min(1, "Add at least one action").max(MAX_ACTIONS, `At most ${MAX_ACTIONS} actions`);

/**
 * Definition-level rules that span trigger and actions. Returns a user-facing
 * message, or null when the definition is acceptable.
 */
export function selfTriggerProblem(event: TriggerEvent, actions: Array<{ type: string }>): string | null {
  if (SYNTHESIS_DOWNSTREAM_EVENTS.has(event) && actions.some((a) => a.type === "RUN_SYNTHESIS")) {
    return `A workflow triggered by "${TRIGGER_EVENTS[event].label}" cannot run a synthesis: it would trigger itself in a loop.`;
  }
  return null;
}

/** Placeholder names available in message templates for an event. */
export function placeholdersFor(event: TriggerEvent): string[] {
  return ["event", "project", "workflow", "link", ...eventFields(event).filter((f) => f.type !== "array").map((f) => f.name)];
}
