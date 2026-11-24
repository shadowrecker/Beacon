/**
 * Built-in workflow templates. Each one is a definition that passes the same
 * validation as a user-built workflow (a test asserts this). Templates are
 * installed disabled so the installer reviews channels and recipients first.
 */
import type { ActionType, TriggerEvent, WorkflowActionInput, WorkflowCondition } from "./definitions";

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: "Alerts" | "Notifications" | "Roadmap" | "Issue tracking" | "AI";
  trigger: { event: TriggerEvent; conditions: WorkflowCondition[] };
  actions: WorkflowActionInput[];
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "brief-high-impact-recommendations",
    name: "Brief high-impact recommendations",
    description: "Generate a feature brief for every new high-impact, high-confidence recommendation and tell the team in Slack.",
    category: "AI",
    trigger: {
      event: "recommendation.created",
      conditions: [
        { field: "impact", operator: "eq", value: "HIGH" },
        { field: "confidence", operator: "gt", value: 0.75 },
      ],
    },
    actions: [
      { type: "CREATE_BRIEF", params: {} },
      { type: "NOTIFY_SLACK", params: { message: "New high-impact recommendation with a brief: {{title}} ({{project}}) {{link}}" } },
    ],
  },
  {
    id: "synthesis-slack-summary",
    name: "Post synthesis results to Slack",
    description: "Tell your team in Slack whenever a synthesis finishes.",
    category: "Notifications",
    trigger: { event: "synthesis.completed", conditions: [] },
    actions: [{ type: "NOTIFY_SLACK", params: { message: "Synthesis finished for {{project}} with {{themeCount}} themes. {{link}}" } }],
  },
  {
    id: "negative-theme-alert",
    name: "Alert on strong negative themes",
    description: "Alert admins in-app and in Slack when a confident negative theme is detected.",
    category: "Alerts",
    trigger: {
      event: "theme.detected",
      conditions: [
        { field: "sentiment", operator: "eq", value: "NEGATIVE" },
        { field: "confidence", operator: "gt", value: 0.85 },
      ],
    },
    actions: [
      {
        type: "ALERT_TEAM",
        params: { audience: "role:ADMIN", priority: "HIGH", title: "Negative theme: {{name}}", message: "A confident negative theme was detected in {{project}}." },
      },
      { type: "NOTIFY_SLACK", params: { message: "Negative theme detected in {{project}}: {{name}} {{link}}" } },
    ],
  },
  {
    id: "competitor-pricing-alert",
    name: "Competitor pricing alert",
    description: "Email workspace admins when a tracked competitor changes pricing.",
    category: "Alerts",
    trigger: { event: "competitor.updated", conditions: [{ field: "type", operator: "eq", value: "PRICING" }] },
    actions: [
      {
        type: "NOTIFY_EMAIL",
        params: { recipients: ["role:ADMIN"], subject: "Competitor pricing change: {{title}}", message: "A tracked competitor changed pricing: {{title}}. Review it in Beacon: {{link}}" },
      },
    ],
  },
  {
    id: "accepted-to-roadmap",
    name: "Add accepted recommendations to the roadmap",
    description: "When a recommendation is accepted, add it to the project's roadmap.",
    category: "Roadmap",
    trigger: { event: "recommendation.status_changed", conditions: [{ field: "to", operator: "eq", value: "ACCEPTED" }] },
    actions: [{ type: "ADD_TO_ROADMAP", params: { priority: "P1" } }],
  },
  {
    id: "accepted-to-jira",
    name: "Create Jira issues for accepted recommendations",
    description: "When a recommendation is accepted, open an issue in your connected Jira project.",
    category: "Issue tracking",
    trigger: { event: "recommendation.status_changed", conditions: [{ field: "to", operator: "eq", value: "ACCEPTED" }] },
    actions: [{ type: "EXPORT_TO_JIRA", params: { issueType: "Story" } }],
  },
  {
    id: "accepted-to-linear",
    name: "Create Linear issues for accepted recommendations",
    description: "When a recommendation is accepted, open an issue for your connected Linear team.",
    category: "Issue tracking",
    trigger: { event: "recommendation.status_changed", conditions: [{ field: "to", operator: "eq", value: "ACCEPTED" }] },
    actions: [{ type: "EXPORT_TO_LINEAR", params: {} }],
  },
  {
    id: "resynthesize-on-new-feedback",
    name: "Re-synthesize when feedback arrives",
    description: "Start a synthesis when a new document finishes processing (at most a few times per hour).",
    category: "AI",
    trigger: { event: "document.ready", conditions: [{ field: "chunkCount", operator: "gt", value: 0 }] },
    actions: [{ type: "RUN_SYNTHESIS", params: { type: "FULL" } }],
  },
  {
    id: "sentiment-alert-email",
    name: "Email admins on sentiment alerts",
    description: "Email workspace admins when a high-severity sentiment alert fires.",
    category: "Alerts",
    trigger: { event: "sentiment.alert", conditions: [{ field: "severity", operator: "in", value: ["HIGH", "CRITICAL"] }] },
    actions: [
      {
        type: "NOTIFY_EMAIL",
        params: { recipients: ["role:ADMIN"], subject: "Sentiment alert: {{title}}", message: "A {{severity}} sentiment alert fired in {{project}}: {{title}}. {{link}}" },
      },
    ],
  },
  {
    id: "integration-failure-alert",
    name: "Alert admins when an integration sync fails",
    description: "Send an in-app alert to admins when an integration sync fails.",
    category: "Alerts",
    trigger: { event: "integration.failed", conditions: [] },
    actions: [
      {
        type: "ALERT_TEAM",
        params: { audience: "role:ADMIN", priority: "MEDIUM", title: "{{provider}} sync failed", message: "The {{provider}} integration failed to sync. Check its settings." },
      },
    ],
  },
];

export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id);
}

export function templateActionTypes(t: WorkflowTemplate): ActionType[] {
  return t.actions.map((a) => a.type);
}
