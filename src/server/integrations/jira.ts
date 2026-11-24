/**
 * Jira Cloud: issues with comments → NOTE documents.
 *
 * Auth: Atlassian account email + API token (Basic). The site comes from
 * `jiraBaseUrl(siteSubdomain)` (outbound.ts), which validates the subdomain.
 * Sync uses the enhanced JQL search (`/rest/api/3/search/jql`, token
 * pagination). JQL dates are interpreted in the API user's time zone, so the
 * window start is formatted in that zone.
 */
import { z } from "zod";
import { jiraBaseUrl } from "./outbound";
import { basicAuth, type ProviderHttp } from "./http";
import {
  advanceWindow,
  commonConfigShape,
  maxIso,
  readWindow,
  toIso,
  type Connector,
  type SyncRecord,
} from "./types";

const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

export const jiraCredentialSchema = z.object({
  siteSubdomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "Enter the part before .atlassian.net"),
  email: z.string().trim().email().max(320),
  apiToken: z.string().trim().min(10, "Paste an Atlassian API token").max(500),
});

export const jiraConfigSchema = z.object({
  /** Only sync these projects. */
  projectKeys: z.array(z.string().regex(JIRA_PROJECT_KEY, "Use project keys like PROD")).max(20).optional(),
  /** Defaults for outbound issue creation. */
  projectKey: z.string().regex(JIRA_PROJECT_KEY).optional(),
  issueType: z.string().trim().min(1).max(60).optional(),
  ...commonConfigShape,
});
type JiraConfig = z.infer<typeof jiraConfigSchema>;

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

/** Atlassian Document Format → plain text. */
export function adfToText(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object" || depth > 40) return typeof node === "string" ? node : "";
  const n = node as AdfNode;
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention") return String((n.attrs?.text as string | undefined) ?? "@user");
  if (n.type === "emoji") return String((n.attrs?.text as string | undefined) ?? "");
  if (n.type === "inlineCard") return String((n.attrs?.url as string | undefined) ?? "");
  const children = (n.content ?? []).map((c) => adfToText(c, depth + 1));
  switch (n.type) {
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
    case "panel":
      return `${children.join("")}\n\n`;
    case "listItem":
      return `- ${children.join("").trim()}\n`;
    case "bulletList":
    case "orderedList":
      return `${children.join("")}\n`;
    case "tableRow":
      return `${children.map((c) => c.trim()).join(" | ")}\n`;
    default:
      return children.join("");
  }
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string } | null;
    priority?: { name?: string } | null;
    issuetype?: { name?: string } | null;
    labels?: string[];
    created?: string;
    updated?: string;
    reporter?: { displayName?: string } | null;
    comment?: { comments?: Array<{ author?: { displayName?: string }; body?: unknown; created?: string }> } | null;
  };
}

export function mapJiraIssue(issue: JiraIssue, base: string): SyncRecord | null {
  if (!/^[A-Z][A-Z0-9_]{1,9}-\d{1,9}$/.test(issue.key)) return null;
  const f = issue.fields ?? {};
  const header = [
    f.issuetype?.name ? `Type: ${f.issuetype.name}` : null,
    f.status?.name ? `Status: ${f.status.name}` : null,
    f.priority?.name ? `Priority: ${f.priority.name}` : null,
    f.labels?.length ? `Labels: ${f.labels.slice(0, 20).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const description = adfToText(f.description).trim();
  const lines = [header, description ? `${f.reporter?.displayName ?? "Reporter"}: ${description}` : null];
  for (const c of (f.comment?.comments ?? []).slice(0, 50)) {
    const body = adfToText(c.body).trim();
    if (body) lines.push(`${c.author?.displayName ?? "Comment"}: ${body}`);
  }
  return {
    externalId: `issue:${issue.id}`,
    title: `${issue.key}: ${f.summary ?? ""}`.slice(0, 300),
    type: "NOTE",
    text: lines.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n"),
    sourceUrl: `${base}/browse/${issue.key}`,
    metadata: { provider: "JIRA", key: issue.key, status: f.status?.name ?? null, labels: (f.labels ?? []).slice(0, 20), createdAt: toIso(f.created) },
  };
}

/** "yyyy/MM/dd HH:mm" in the given IANA time zone (JQL's date format). */
export function jqlDate(iso: string, timeZone: string | undefined): string {
  let tz = "UTC";
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      tz = timeZone;
    } catch {
      tz = "UTC";
    }
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

const FIELDS = ["summary", "description", "status", "priority", "issuetype", "labels", "created", "updated", "reporter", "comment"];

export const jiraConnector: Connector<JiraConfig> = {
  provider: "JIRA",
  auth: "apiKey",
  configSchema: jiraConfigSchema,
  credentialSchema: jiraCredentialSchema,
  authHeaders: (creds) => ({ authorization: basicAuth(creds.email ?? "", creds.apiToken ?? "") }),

  async testConnection(http: ProviderHttp, creds) {
    const base = jiraBaseUrl(creds.siteSubdomain ?? "");
    const me = await http.json<{ displayName?: string; timeZone?: string }>(`${base}/rest/api/3/myself`);
    return { accountLabel: `${new URL(base).hostname}${me.displayName ? ` (${me.displayName})` : ""}` };
  },

  async *sync(ctx) {
    const base = jiraBaseUrl(ctx.credentials.siteSubdomain ?? "");
    let win = readWindow(ctx.cursor, ctx.now, ctx.backfillDays);
    let highWater = win.highWater;
    let records = 0;

    const me = await ctx.http.json<{ timeZone?: string }>(`${base}/rest/api/3/myself`);
    // Minute precision: start one minute early; unchanged records are no-ops on ingest.
    const since = new Date(Date.parse(win.since!) - 60_000).toISOString();
    const projects = (ctx.config.projectKeys ?? []).filter((k) => JIRA_PROJECT_KEY.test(k));
    const jql = [`updated >= "${jqlDate(since, me.timeZone)}"`, projects.length ? `project in (${projects.join(",")})` : null]
      .filter(Boolean)
      .join(" AND ")
      .concat(" ORDER BY updated ASC");

    for (let page = 0; page < ctx.limits.maxPages && records < ctx.limits.maxRecords; page++) {
      const res = await ctx.http.json<{ issues?: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean }>(
        `${base}/rest/api/3/search/jql`,
        { method: "POST", json: { jql, fields: FIELDS, maxResults: 50, ...(win.after ? { nextPageToken: win.after } : {}) } }
      );
      const batch: SyncRecord[] = [];
      for (const issue of res.issues ?? []) {
        const rec = mapJiraIssue(issue, base);
        if (!rec) continue;
        highWater = maxIso(highWater, toIso(issue.fields?.updated));
        batch.push(rec);
      }
      records += batch.length;
      const next = res.isLast !== true && res.nextPageToken ? res.nextPageToken : null;
      win = advanceWindow(win, next, highWater);
      yield { records: batch, cursor: win, done: !next };
      if (!next) return;
      highWater = win.highWater;
    }
  },
};
