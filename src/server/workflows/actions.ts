/**
 * Workflow action executors.
 *
 * Every executor receives an ActionContext built by the runner from the stored
 * workflow: the org comes from workflow.projectId -> project.orgId and is never
 * read from params. Every foreign ID (recommendation, roadmap, user) is looked up
 * scoped to that project/org. Params were validated by the per-action zod schema
 * (definitions.ts) before the executor is called.
 */
import type { OrgMemberRole } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { Logger } from "@/lib/logger";
import { enqueue, QUEUE } from "../jobs/queues";
import { NonRetryableError } from "../jobs/worker";
import { notify } from "../notifications/notify";
import { createJiraIssue, createLinearIssue, postSlackMessage } from "../integrations/outbound";
import { assertTokenBudget, BudgetExceededError } from "../usage/entitlements";
import {
  ACTION_META,
  TRIGGER_EVENTS,
  type ActionParams,
  type RoleGroup,
  type TriggerEvent,
  type WorkflowAction,
} from "./definitions";
import { appUrl, escapeMarkdown, payloadVars, renderTemplate } from "./render";
import { getOrGenerateBrief } from "../ai/brief";

export interface ActionContext {
  runId: string;
  actionIndex: number;
  workflow: { id: string; name: string; projectId: string };
  project: { id: string; name: string; orgId: string };
  /** The triggering event, or null for a manual run. */
  event: { id: string; type: TriggerEvent; payload: unknown; causationDepth: number } | null;
  log: Logger;
}

export interface ActionOutcome {
  status: "success" | "skipped";
  message: string;
  /** Small, safe references only (IDs, keys, links). Never upstream bodies. */
  output?: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ROLE_SETS: Record<RoleGroup, OrgMemberRole[]> = {
  "role:OWNER": ["OWNER"],
  "role:ADMIN": ["OWNER", "ADMIN"],
  "role:MEMBER": ["OWNER", "ADMIN", "MEMBER"],
  "role:ALL": ["OWNER", "ADMIN", "MEMBER", "VIEWER"],
};

/** Joined members of `orgId` matching user IDs or role groups (never addresses). */
export async function resolveRecipients(orgId: string, recipients: string[]): Promise<string[]> {
  const roles = new Set<OrgMemberRole>();
  const userIds: string[] = [];
  for (const r of recipients) {
    if (r in ROLE_SETS) ROLE_SETS[r as RoleGroup].forEach((role) => roles.add(role));
    else userIds.push(r);
  }
  const or: Array<Record<string, unknown>> = [];
  if (userIds.length) or.push({ userId: { in: userIds } });
  if (roles.size) or.push({ role: { in: [...roles] } });
  if (or.length === 0) return [];
  const members = await prisma.orgMember.findMany({
    where: { orgId, joinedAt: { not: null }, OR: or },
    select: { userId: true },
    take: 500,
  });
  return [...new Set(members.map((m) => m.userId))];
}

function templateVars(ctx: ActionContext): Record<string, unknown> {
  return {
    ...(ctx.event ? payloadVars(ctx.event.payload) : {}),
    event: ctx.event ? TRIGGER_EVENTS[ctx.event.type].label : "Manual run",
    project: ctx.project.name,
    workflow: ctx.workflow.name,
    link: appUrl(`/projects/${ctx.project.id}`),
  };
}

function eventRecommendationId(ctx: ActionContext): string | null {
  const p = ctx.event?.payload;
  if (p && typeof p === "object" && typeof (p as Record<string, unknown>).recommendationId === "string") {
    return (p as Record<string, string>).recommendationId;
  }
  return null;
}

/** The recommendation an action works on, scoped to the workflow's project. */
async function loadRecommendation(ctx: ActionContext, paramId: string | undefined) {
  const id = paramId ?? eventRecommendationId(ctx);
  if (!id) throw new NonRetryableError("No recommendation: the trigger event has none and no recommendation is configured");
  const rec = await prisma.recommendation.findFirst({
    where: { id, projectId: ctx.project.id },
    select: { id: true, title: true, description: true, impact: true, confidence: true },
  });
  if (!rec) throw new NonRetryableError("Recommendation not found in this workflow's project");
  return rec;
}

function issueDescription(ctx: ActionContext, rec: { id: string; description: string; impact: string; confidence: number }, markdown: boolean): string {
  const body = markdown ? escapeMarkdown(rec.description) : rec.description;
  return [
    body.slice(0, 20_000),
    `Impact: ${rec.impact} · Confidence: ${Math.round(rec.confidence * 100)}%`,
    `Created by the Beacon workflow "${ctx.workflow.name}" from project "${ctx.project.name}".`,
    appUrl(`/projects/${ctx.project.id}`),
  ].join("\n\n");
}

function dedupeKey(ctx: ActionContext): string {
  return `wf_${ctx.runId}_${ctx.actionIndex}`;
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

async function notifySlack(ctx: ActionContext, params: ActionParams<"NOTIFY_SLACK">): Promise<ActionOutcome> {
  const text = renderTemplate(params.message, templateVars(ctx), "slack");
  const res = await postSlackMessage(ctx.project.orgId, { text, channel: params.channel });
  return { status: "success", message: "Posted to Slack", output: { channel: res.channel, ts: res.ts } };
}

async function notifyEmail(ctx: ActionContext, params: ActionParams<"NOTIFY_EMAIL">): Promise<ActionOutcome> {
  const userIds = await resolveRecipients(ctx.project.orgId, params.recipients);
  if (userIds.length === 0) throw new NonRetryableError("None of the recipients are members of this workspace");
  const vars = templateVars(ctx);
  const title = renderTemplate(params.subject, vars, "text");
  const message = renderTemplate(params.message, vars, "text");
  const href = `/projects/${ctx.project.id}`;
  const key = dedupeKey(ctx);
  // In-app notification for everyone (idempotent per run/action).
  await notify({
    userIds,
    type: "WORKFLOW",
    title,
    message,
    resourceType: "workflow_run",
    resourceId: `${ctx.runId}.${ctx.actionIndex}`,
    href,
    dedupeKey: key,
  });
  // Email: this action exists to email, so members who have not set a WORKFLOW
  // email preference get one. notify() already emailed members who opted in,
  // and members who opted out get none.
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, notificationPrefs: true },
  });
  let emailed = 0;
  for (const u of users) {
    const pref = ((u.notificationPrefs ?? {}) as Record<string, { email?: boolean } | undefined>).WORKFLOW?.email;
    if (!u.email || pref !== undefined) {
      if (u.email && pref === true) emailed++;
      continue;
    }
    await enqueue(
      QUEUE.EMAIL,
      { to: u.email, template: "notification", data: { title, message, href }, dedupeKey: `${key}_${u.id}` },
      { jobId: `email_${key}_${u.id}` }
    );
    emailed++;
  }
  return { status: "success", message: `Notified ${userIds.length} member(s); ${emailed} by email`, output: { recipients: userIds.length, emailed } };
}

async function alertTeam(ctx: ActionContext, params: ActionParams<"ALERT_TEAM">): Promise<ActionOutcome> {
  const userIds = await resolveRecipients(ctx.project.orgId, [params.audience]);
  if (userIds.length === 0) throw new NonRetryableError("No workspace members match the alert audience");
  const vars = templateVars(ctx);
  const title = renderTemplate(params.title, vars, "text");
  const prefixed = params.priority === "HIGH" ? `[High priority] ${title}` : title;
  const created = await notify({
    userIds,
    type: "WORKFLOW",
    title: prefixed,
    message: renderTemplate(params.message, vars, "text"),
    resourceType: "workflow_run",
    resourceId: `${ctx.runId}.${ctx.actionIndex}`,
    href: `/projects/${ctx.project.id}`,
    dedupeKey: dedupeKey(ctx),
  });
  return { status: "success", message: `Alerted ${userIds.length} member(s)`, output: { recipients: userIds.length, created } };
}

async function assignUser(ctx: ActionContext, params: ActionParams<"ASSIGN_USER">): Promise<ActionOutcome> {
  const [userId] = await resolveRecipients(ctx.project.orgId, [params.userId]);
  if (!userId) throw new NonRetryableError("The assignee is no longer a member of this workspace");
  const vars = templateVars(ctx);
  const subject = typeof vars.title === "string" ? vars.title : typeof vars.name === "string" ? vars.name : ctx.workflow.name;
  const note = params.note ? renderTemplate(params.note, vars, "text") : `The workflow "${ctx.workflow.name}" assigned this to you.`;
  await notify({
    userIds: [userId],
    type: "WORKFLOW",
    title: renderTemplate(`Assigned to you: {{subject}}`, { subject }, "text"),
    message: note,
    resourceType: "workflow_run",
    resourceId: `${ctx.runId}.${ctx.actionIndex}`,
    href: `/projects/${ctx.project.id}`,
    dedupeKey: dedupeKey(ctx),
  });
  return { status: "success", message: "Assignee notified", output: { userId } };
}

function currentQuarter(d = new Date()): string {
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

async function addToRoadmap(ctx: ActionContext, params: ActionParams<"ADD_TO_ROADMAP">): Promise<ActionOutcome> {
  const rec = await loadRecommendation(ctx, params.recommendationId);
  const roadmap = params.roadmapId
    ? await prisma.roadmap.findFirst({ where: { id: params.roadmapId, projectId: ctx.project.id }, select: { id: true, name: true } })
    : await prisma.roadmap.findFirst({ where: { projectId: ctx.project.id }, orderBy: { createdAt: "desc" }, select: { id: true, name: true } });
  if (!roadmap) {
    throw new NonRetryableError(params.roadmapId ? "Roadmap not found in this workflow's project" : "This project has no roadmap yet");
  }
  const externalId = `beacon-recommendation:${rec.id}`;
  const item = await prisma.roadmapItem.upsert({
    where: { roadmapId_externalId: { roadmapId: roadmap.id, externalId } },
    update: {},
    create: {
      roadmapId: roadmap.id,
      externalId,
      title: rec.title.slice(0, 300),
      description: rec.description.slice(0, 10_000),
      priority: params.priority,
      quarter: params.quarter ?? currentQuarter(),
      status: "PLANNED",
    },
    select: { id: true },
  });
  return { status: "success", message: `Added to roadmap "${roadmap.name.slice(0, 80)}"`, output: { roadmapId: roadmap.id, itemId: item.id } };
}

async function exportToJira(ctx: ActionContext, params: ActionParams<"EXPORT_TO_JIRA">): Promise<ActionOutcome> {
  const rec = await loadRecommendation(ctx, params.recommendationId);
  const issue = await createJiraIssue(ctx.project.orgId, {
    summary: rec.title,
    description: issueDescription(ctx, rec, false),
    projectKey: params.projectKey,
    issueType: params.issueType,
  });
  return { status: "success", message: `Created Jira issue ${issue.key}`, output: { key: issue.key, url: issue.url, recommendationId: rec.id } };
}

async function exportToLinear(ctx: ActionContext, params: ActionParams<"EXPORT_TO_LINEAR">): Promise<ActionOutcome> {
  const rec = await loadRecommendation(ctx, params.recommendationId);
  const issue = await createLinearIssue(ctx.project.orgId, {
    title: rec.title,
    description: issueDescription(ctx, rec, true),
    teamId: params.teamId,
  });
  return {
    status: "success",
    message: `Created Linear issue ${issue.identifier}`,
    output: { id: issue.id, identifier: issue.identifier, url: issue.url, recommendationId: rec.id },
  };
}

async function createBrief(ctx: ActionContext, params: ActionParams<"CREATE_BRIEF">): Promise<ActionOutcome> {
  const rec = await loadRecommendation(ctx, params.recommendationId);
  // Shared brief generator (customer evidence is passed as untrusted data and the
  // brief is stored on Recommendation.brief for the handoff exporter).
  const { generated } = await getOrGenerateBrief(
    { recommendationId: rec.id, projectId: ctx.project.id, orgId: ctx.project.orgId },
    { regenerate: params.regenerate }
  );
  return generated
    ? { status: "success", message: "Brief generated", output: { recommendationId: rec.id } }
    : { status: "skipped", message: "The recommendation already has a brief", output: { recommendationId: rec.id } };
}

async function runSynthesis(ctx: ActionContext, params: ActionParams<"RUN_SYNTHESIS">): Promise<ActionOutcome> {
  const inFlight = await prisma.synthesis.findFirst({
    where: { projectId: ctx.project.id, status: { in: ["PENDING", "PROCESSING"] } },
    select: { id: true },
  });
  if (inFlight) return { status: "skipped", message: "A synthesis is already running for this project", output: { synthesisId: inFlight.id } };
  const ready = await prisma.document.count({ where: { projectId: ctx.project.id, status: "READY" } });
  if (ready === 0) throw new NonRetryableError("The project has no processed documents to synthesize");
  try {
    await assertTokenBudget(ctx.project.orgId);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw new NonRetryableError(err.message);
    throw err;
  }
  const synthesis = await prisma.synthesis.create({
    // One level deeper than the event that triggered this workflow (loop guard).
    data: { projectId: ctx.project.id, type: params.type, status: "PENDING", causationDepth: (ctx.event?.causationDepth ?? 0) + 1 },
    select: { id: true },
  });
  await enqueue(QUEUE.SYNTHESIS, { synthesisId: synthesis.id }, { jobId: `syn_${synthesis.id}` });
  return { status: "success", message: "Synthesis started", output: { synthesisId: synthesis.id } };
}

export async function executeAction(ctx: ActionContext, action: WorkflowAction): Promise<ActionOutcome> {
  switch (action.type) {
    case "NOTIFY_SLACK":
      return notifySlack(ctx, action.params);
    case "NOTIFY_EMAIL":
      return notifyEmail(ctx, action.params);
    case "ALERT_TEAM":
      return alertTeam(ctx, action.params);
    case "ASSIGN_USER":
      return assignUser(ctx, action.params);
    case "ADD_TO_ROADMAP":
      return addToRoadmap(ctx, action.params);
    case "EXPORT_TO_JIRA":
      return exportToJira(ctx, action.params);
    case "EXPORT_TO_LINEAR":
      return exportToLinear(ctx, action.params);
    case "CREATE_BRIEF":
      return createBrief(ctx, action.params);
    case "RUN_SYNTHESIS":
      return runSynthesis(ctx, action.params);
  }
}

export function actionLabel(type: string): string {
  return type in ACTION_META ? ACTION_META[type as keyof typeof ACTION_META].label : type;
}
