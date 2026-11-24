/**
 * Roadmap importer: CSV uploads and connected Linear / Jira / Notion /
 * Productboard workspaces.
 *
 * CSV imports run in the request (bounded); integration imports run in the
 * import worker (QUEUE.IMPORTS) from a ROADMAP_IMPORT JobRun. Both go through
 * runRoadmapImport (load -> create or reuse roadmap -> upsert -> metadata).
 *
 * Integration imports use the org's own connected integration
 * (getOrgIntegrationCredentials(project.orgId, provider)), where the orgId comes
 * from the project the caller is authorized for, never from request input.
 * Every request goes through safeFetch to a fixed provider host (Jira's site is
 * a strictly validated *.atlassian.net subdomain). Imports are bounded
 * (MAX_IMPORT_ITEMS) and upsert on (roadmapId, externalId), so re-importing the
 * same source updates items instead of duplicating them.
 */
import { createHash } from "node:crypto";
import type { Prisma, RoadmapItemPriority, RoadmapItemStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { safeFetch, SafeFetchError } from "@/lib/safe-fetch";
import { NonRetryableError } from "@/server/jobs/worker";
import { getOrgIntegrationCredentials, type Credentials } from "@/server/integrations/credentials";
import { jiraBaseUrl } from "@/server/integrations/outbound";
import { htmlToText } from "@/server/ai/competitive/html";
import { CsvError, findColumn, parseCsv } from "./csv";

export const MAX_CSV_BYTES = 1024 * 1024;
export const MAX_CSV_ROWS = 2_000;
export const MAX_IMPORT_ITEMS = 500;
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15_000;

export const ROADMAP_ITEM_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export const ROADMAP_ITEM_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/** Canonical shape of an item to upsert; every source maps to this. */
export const roadmapItemInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5_000).nullable(),
  status: z.enum(ROADMAP_ITEM_STATUSES),
  priority: z.enum(ROADMAP_ITEM_PRIORITIES),
  quarter: z.string().max(50).nullable(),
  externalId: z.string().min(1).max(200),
});
export type RoadmapItemInput = z.infer<typeof roadmapItemInputSchema>;

export interface ImportSkip {
  row: number;
  reason: string;
}

export interface ParsedItems {
  items: RoadmapItemInput[];
  skipped: ImportSkip[];
  truncated: boolean;
}

export class ImportError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function clip(text: string | null | undefined, max: number): string | null {
  if (text === null || text === undefined) return null;
  const t = text.replace(/\u0000/g, "").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function normalizeStatus(raw: string | null | undefined): RoadmapItemStatus {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (["inprogress", "started", "doing", "active", "inreview", "review", "building", "indeterminate"].includes(s)) {
    return "IN_PROGRESS";
  }
  if (["completed", "complete", "done", "shipped", "released", "closed", "resolved"].includes(s)) return "COMPLETED";
  if (["cancelled", "canceled", "wontdo", "wontfix", "dropped", "abandoned", "duplicate"].includes(s)) return "CANCELLED";
  return "PLANNED";
}

export function normalizePriority(raw: string | number | null | undefined): RoadmapItemPriority {
  if (typeof raw === "number") {
    // Linear: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
    return raw === 1 ? "P0" : raw === 2 ? "P1" : raw === 4 ? "P3" : "P2";
  }
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/^p[0-3]$/.test(s)) return s.toUpperCase() as RoadmapItemPriority;
  if (["urgent", "highest", "blocker", "critical"].includes(s)) return "P0";
  if (["high", "major"].includes(s)) return "P1";
  if (["low", "lowest", "minor", "trivial"].includes(s)) return "P3";
  return "P2";
}

/** Deterministic external id for CSV rows without one, so re-imports upsert. */
export function csvExternalId(title: string): string {
  const digest = createHash("sha256").update(title.trim().toLowerCase()).digest("hex").slice(0, 24);
  return `csv:${digest}`;
}

function cred(credentials: Credentials, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = credentials[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function configOf(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" ? (config as Record<string, unknown>) : {};
}

function upstreamError(provider: string, status: number): Error {
  const err = new Error(`${provider} request failed with status ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function parseRoadmapCsv(text: string): ParsedItems {
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) {
    throw new ImportError(`The CSV file is larger than ${MAX_CSV_BYTES / 1024} KB`);
  }
  let parsed;
  try {
    parsed = parseCsv(text, { maxRows: MAX_CSV_ROWS, maxColumns: 50, maxFieldLength: 10_000 });
  } catch (err) {
    if (err instanceof CsvError) throw new ImportError(err.message);
    throw err;
  }
  const { header, rows, truncated } = parsed;
  const col = {
    title: findColumn(header, ["title", "name", "summary"]),
    description: findColumn(header, ["description", "details", "body"]),
    status: findColumn(header, ["status", "state"]),
    priority: findColumn(header, ["priority"]),
    quarter: findColumn(header, ["quarter", "timeline", "release", "target"]),
    externalId: findColumn(header, ["externalId", "external_id", "id", "key", "issueKey"]),
  };
  if (col.title < 0) throw new ImportError('The CSV needs a "title" column');

  const items: RoadmapItemInput[] = [];
  const skipped: ImportSkip[] = [];
  const seen = new Set<string>();
  const cell = (row: string[], idx: number) => (idx >= 0 ? row[idx] ?? "" : "");

  rows.forEach((row, i) => {
    const line = i + 2; // 1-based, after the header
    const title = clip(cell(row, col.title), 300);
    if (!title) {
      skipped.push({ row: line, reason: "missing title" });
      return;
    }
    const externalId = clip(cell(row, col.externalId), 200) ?? csvExternalId(title);
    if (seen.has(externalId)) {
      skipped.push({ row: line, reason: "duplicate of an earlier row" });
      return;
    }
    seen.add(externalId);
    items.push({
      title,
      description: clip(cell(row, col.description), 5_000),
      status: normalizeStatus(cell(row, col.status)),
      priority: normalizePriority(cell(row, col.priority)),
      quarter: clip(cell(row, col.quarter), 50),
      externalId,
    });
  });
  return { items, skipped, truncated };
}

// ---------------------------------------------------------------------------
// Linear (GraphQL, fixed host)
// ---------------------------------------------------------------------------

const LINEAR_ID = /^[a-zA-Z0-9-]{1,64}$/;

interface LinearIssueNode {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  state?: { name?: string | null; type?: string | null } | null;
  cycle?: { name?: string | null; number?: number | null } | null;
  project?: { name?: string | null } | null;
}

function linearStatus(state: LinearIssueNode["state"]): RoadmapItemStatus {
  switch (state?.type) {
    case "started":
      return "IN_PROGRESS";
    case "completed":
      return "COMPLETED";
    case "canceled":
      return "CANCELLED";
    case "backlog":
    case "unstarted":
    case "triage":
      return "PLANNED";
    default:
      return normalizeStatus(state?.name);
  }
}

export async function fetchLinearItems(orgId: string, opts: { teamId?: string } = {}): Promise<ParsedItems> {
  const integ = await getOrgIntegrationCredentials(orgId, "LINEAR");
  if (!integ) throw new ImportError("Linear is not connected for this workspace");
  const apiKey = cred(integ.credentials, "apiKey", "api_key");
  const oauth = cred(integ.credentials, "accessToken", "access_token");
  if (!apiKey && !oauth) throw new ImportError("Linear credentials are incomplete");
  const teamId = opts.teamId ?? (configOf(integ.config).teamId as string | undefined);
  if (!teamId || !LINEAR_ID.test(teamId)) throw new ImportError("Choose a valid Linear team to import from");

  const query = `query RoadmapIssues($teamId: ID!, $after: String) {
    issues(first: ${PAGE_SIZE}, after: $after, filter: { team: { id: { eq: $teamId } } }, orderBy: updatedAt) {
      nodes { id identifier title description priority state { name type } cycle { name number } project { name } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

  const items: RoadmapItemInput[] = [];
  const skipped: ImportSkip[] = [];
  let after: string | null = null;
  let truncated = false;
  for (let page = 0; ; page++) {
    const res = await safeFetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: apiKey ?? `Bearer ${oauth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables: { teamId, after } }),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!res.ok) throw upstreamError("Linear", res.status);
    const body = res.json<{
      data?: { issues?: { nodes?: LinearIssueNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
      errors?: unknown[];
    }>();
    if (body.errors?.length || !body.data?.issues) throw new ImportError("Linear rejected the import request");
    for (const node of body.data.issues.nodes ?? []) {
      const title = clip(node.title, 300);
      if (!title || !node.id) {
        skipped.push({ row: items.length + skipped.length + 1, reason: "issue without a title" });
        continue;
      }
      items.push({
        title,
        description: clip(node.description, 5_000),
        status: linearStatus(node.state),
        priority: normalizePriority(node.priority ?? 0),
        quarter: clip(node.cycle?.name ?? (node.cycle?.number ? `Cycle ${node.cycle.number}` : node.project?.name), 50),
        externalId: clip(node.id, 200)!,
      });
    }
    const info = body.data.issues.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) break;
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    after = info.endCursor;
  }
  return { items: items.slice(0, MAX_IMPORT_ITEMS), skipped, truncated: truncated || items.length > MAX_IMPORT_ITEMS };
}

// ---------------------------------------------------------------------------
// Jira Cloud (REST v3 enhanced search, validated *.atlassian.net site)
// ---------------------------------------------------------------------------

const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/** Plain text from an Atlassian Document Format tree (bounded). */
export function adfToText(node: unknown, max = 5_000): string {
  const out: string[] = [];
  let length = 0;
  const walk = (n: AdfNode | undefined, depth: number) => {
    if (!n || depth > 20 || length > max) return;
    if (typeof n.text === "string") {
      out.push(n.text);
      length += n.text.length;
    }
    for (const child of n.content ?? []) walk(child, depth + 1);
    if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem") out.push("\n");
  };
  if (typeof node === "string") return node.slice(0, max);
  walk(node as AdfNode, 0);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string | null;
    description?: unknown;
    status?: { name?: string | null; statusCategory?: { key?: string | null } | null } | null;
    priority?: { name?: string | null } | null;
    fixVersions?: Array<{ name?: string | null }> | null;
  };
}

function jiraStatus(status: NonNullable<JiraIssue["fields"]>["status"]): RoadmapItemStatus {
  const name = status?.name ?? "";
  if (/cancel|won.?t|reject|duplicate/i.test(name)) return "CANCELLED";
  switch (status?.statusCategory?.key) {
    case "indeterminate":
      return "IN_PROGRESS";
    case "done":
      return "COMPLETED";
    case "new":
      return "PLANNED";
    default:
      return normalizeStatus(name);
  }
}

export async function fetchJiraItems(orgId: string, opts: { projectKey?: string } = {}): Promise<ParsedItems> {
  const integ = await getOrgIntegrationCredentials(orgId, "JIRA");
  if (!integ) throw new ImportError("Jira is not connected for this workspace");
  const email = cred(integ.credentials, "email");
  const apiToken = cred(integ.credentials, "apiToken", "api_token");
  const site = cred(integ.credentials, "siteSubdomain", "site_subdomain");
  if (!email || !apiToken || !site) throw new ImportError("Jira credentials are incomplete");
  const projectKey = (opts.projectKey ?? (configOf(integ.config).projectKey as string | undefined))?.toUpperCase();
  if (!projectKey || !JIRA_PROJECT_KEY.test(projectKey)) throw new ImportError("Enter a valid Jira project key");
  const base = jiraBaseUrl(site);
  const auth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  // The key is validated above, so it is safe to embed in JQL.
  const jql = `project = "${projectKey}" ORDER BY updated DESC`;

  const items: RoadmapItemInput[] = [];
  const skipped: ImportSkip[] = [];
  let nextPageToken: string | undefined;
  let truncated = false;
  for (;;) {
    const qs = new URLSearchParams({
      jql,
      maxResults: String(PAGE_SIZE),
      fields: "summary,description,status,priority,fixVersions",
    });
    if (nextPageToken) qs.set("nextPageToken", nextPageToken);
    const res = await safeFetch(`${base}/rest/api/3/search/jql?${qs.toString()}`, {
      headers: { authorization: auth, accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!res.ok) throw upstreamError("Jira", res.status);
    const body = res.json<{ issues?: JiraIssue[]; nextPageToken?: string | null; isLast?: boolean }>();
    for (const issue of body.issues ?? []) {
      const title = clip(issue.fields?.summary, 300);
      if (!title || !issue.key) {
        skipped.push({ row: items.length + skipped.length + 1, reason: "issue without a summary" });
        continue;
      }
      items.push({
        title,
        description: clip(adfToText(issue.fields?.description), 5_000),
        status: jiraStatus(issue.fields?.status),
        priority: normalizePriority(issue.fields?.priority?.name),
        quarter: clip(issue.fields?.fixVersions?.[0]?.name, 50),
        externalId: clip(issue.key, 200)!,
      });
    }
    if (body.isLast !== false || !body.nextPageToken) break;
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    nextPageToken = body.nextPageToken;
  }
  return { items: items.slice(0, MAX_IMPORT_ITEMS), skipped, truncated: truncated || items.length > MAX_IMPORT_ITEMS };
}

// ---------------------------------------------------------------------------
// Notion (database query, fixed host)
// ---------------------------------------------------------------------------

const NOTION_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

type NotionProperty = {
  type?: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
  date?: { start?: string } | null;
};

function notionText(p: NotionProperty | undefined): string | null {
  if (!p) return null;
  switch (p.type) {
    case "title":
      return (p.title ?? []).map((t) => t.plain_text ?? "").join("") || null;
    case "rich_text":
      return (p.rich_text ?? []).map((t) => t.plain_text ?? "").join("") || null;
    case "select":
      return p.select?.name ?? null;
    case "status":
      return p.status?.name ?? null;
    case "multi_select":
      return (p.multi_select ?? []).map((s) => s.name ?? "").filter(Boolean).join(", ") || null;
    case "date":
      return p.date?.start ?? null;
    default:
      return null;
  }
}

function notionProp(props: Record<string, NotionProperty>, pattern: RegExp, types?: string[]): NotionProperty | undefined {
  const entry = Object.entries(props).find(([name, p]) => pattern.test(name) && (!types || types.includes(p.type ?? "")));
  return entry?.[1];
}

export async function fetchNotionItems(orgId: string, opts: { databaseId?: string } = {}): Promise<ParsedItems> {
  const integ = await getOrgIntegrationCredentials(orgId, "NOTION");
  if (!integ) throw new ImportError("Notion is not connected for this workspace");
  const token = cred(integ.credentials, "accessToken", "access_token", "apiKey", "api_key", "token");
  if (!token) throw new ImportError("Notion credentials are incomplete");
  const databaseId = opts.databaseId ?? (configOf(integ.config).databaseId as string | undefined);
  if (!databaseId || !NOTION_ID.test(databaseId)) throw new ImportError("Enter a valid Notion database ID");
  const id = databaseId.replace(/-/g, "").toLowerCase();

  const items: RoadmapItemInput[] = [];
  const skipped: ImportSkip[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (;;) {
    const res = await safeFetch(`https://api.notion.com/v1/databases/${id}/query`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": "2022-06-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ page_size: PAGE_SIZE, ...(cursor ? { start_cursor: cursor } : {}) }),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!res.ok) throw upstreamError("Notion", res.status);
    const body = res.json<{
      results?: Array<{ id?: string; properties?: Record<string, NotionProperty> }>;
      has_more?: boolean;
      next_cursor?: string | null;
    }>();
    for (const page of body.results ?? []) {
      const props = page.properties ?? {};
      const titleProp = Object.values(props).find((p) => p.type === "title");
      const title = clip(notionText(titleProp), 300);
      if (!title || !page.id) {
        skipped.push({ row: items.length + skipped.length + 1, reason: "page without a title" });
        continue;
      }
      items.push({
        title,
        description: clip(notionText(notionProp(props, /description|summary|details/i, ["rich_text"])), 5_000),
        status: normalizeStatus(notionText(notionProp(props, /status|state/i, ["status", "select"]))),
        priority: normalizePriority(notionText(notionProp(props, /priority/i, ["select", "status"]))),
        quarter: clip(notionText(notionProp(props, /quarter|timeline|release|target/i, ["select", "rich_text", "date", "multi_select"])), 50),
        externalId: clip(page.id, 200)!,
      });
    }
    if (!body.has_more || !body.next_cursor) break;
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    cursor = body.next_cursor;
  }
  return { items: items.slice(0, MAX_IMPORT_ITEMS), skipped, truncated: truncated || items.length > MAX_IMPORT_ITEMS };
}

// ---------------------------------------------------------------------------
// Productboard (public API v1 features, fixed host)
// ---------------------------------------------------------------------------

export const PRODUCTBOARD_API = "https://api.productboard.com";
const MAX_PRODUCTBOARD_PAGES = 20;

interface ProductboardFeature {
  id?: string;
  name?: string | null;
  description?: string | null;
  archived?: boolean | null;
  status?: { name?: string | null } | null;
  timeframe?: { startDate?: string | null; endDate?: string | null; granularity?: string | null } | null;
  startDate?: string | null;
}

/** "Q3 2026" from a YYYY-MM-DD start date, or null ("none" and other values are ignored). */
export function quarterFromDate(raw: string | null | undefined): string | null {
  const m = (raw ?? "").match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `Q${Math.ceil(month / 3)} ${m[1]}`;
}

/** Only follow pagination links that stay on the Productboard API host over https. */
export function productboardNextUrl(next: unknown): string | null {
  if (next === null || next === undefined || next === "") return null;
  if (typeof next !== "string") throw new ImportError("Productboard returned an unexpected pagination link");
  let url: URL;
  try {
    url = new URL(next, PRODUCTBOARD_API);
  } catch {
    throw new ImportError("Productboard returned an unexpected pagination link");
  }
  if (url.origin !== PRODUCTBOARD_API || url.username || url.password) {
    throw new ImportError("Productboard returned an unexpected pagination link");
  }
  return url.toString();
}

export async function fetchProductboardItems(orgId: string): Promise<ParsedItems> {
  const integ = await getOrgIntegrationCredentials(orgId, "PRODUCTBOARD");
  if (!integ) throw new ImportError("Productboard is not connected for this workspace");
  const token = cred(integ.credentials, "apiToken", "accessToken", "api_token", "access_token");
  if (!token) throw new ImportError("Productboard credentials are incomplete");
  const headers = { authorization: `Bearer ${token}`, "x-version": "1", accept: "application/json" };

  const items: RoadmapItemInput[] = [];
  const skipped: ImportSkip[] = [];
  const seen = new Set<string>();
  let url: string | null = `${PRODUCTBOARD_API}/features?pageLimit=${PAGE_SIZE}`;
  let truncated = false;
  for (let page = 0; url; page++) {
    if (page >= MAX_PRODUCTBOARD_PAGES || items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    const res = await safeFetch(url, { headers, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!res.ok) throw upstreamError("Productboard", res.status);
    const body = res.json<{ data?: ProductboardFeature[]; links?: { next?: unknown } }>();
    for (const f of body.data ?? []) {
      const title = clip(f.name, 300);
      if (!title || !f.id) {
        skipped.push({ row: items.length + skipped.length + 1, reason: "feature without a name" });
        continue;
      }
      if (f.archived) {
        skipped.push({ row: items.length + skipped.length + 1, reason: "archived feature" });
        continue;
      }
      const externalId = clip(f.id, 200)!;
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      items.push({
        title,
        description: f.description ? clip(htmlToText(f.description, 20_000), 5_000) : null,
        status: normalizeStatus(f.status?.name),
        priority: "P2",
        quarter: quarterFromDate(f.timeframe?.startDate ?? f.startDate),
        externalId,
      });
    }
    url = productboardNextUrl(body.links?.next);
  }
  return { items: items.slice(0, MAX_IMPORT_ITEMS), skipped, truncated: truncated || items.length > MAX_IMPORT_ITEMS };
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export interface UpsertResult {
  created: number;
  updated: number;
}

/**
 * Upsert items into a roadmap on (roadmapId, externalId). Idempotent: importing
 * the same source twice leaves the same set of rows.
 */
export async function upsertRoadmapItems(roadmapId: string, items: RoadmapItemInput[]): Promise<UpsertResult> {
  if (items.length === 0) return { created: 0, updated: 0 };
  const valid = items.map((i) => roadmapItemInputSchema.parse(i));
  const existing = await prisma.roadmapItem.findMany({
    where: { roadmapId, externalId: { in: valid.map((i) => i.externalId) } },
    select: { externalId: true },
  });
  const existingIds = new Set(existing.map((e) => e.externalId));

  const ops: Prisma.PrismaPromise<unknown>[] = valid.map((item) =>
    prisma.roadmapItem.upsert({
      where: { roadmapId_externalId: { roadmapId, externalId: item.externalId } },
      create: { roadmapId, ...item },
      update: {
        title: item.title,
        description: item.description,
        status: item.status,
        priority: item.priority,
        quarter: item.quarter,
      },
    })
  );
  // Chunked so a large import doesn't hold one giant transaction.
  for (let i = 0; i < ops.length; i += 200) {
    await prisma.$transaction(ops.slice(i, i + 200));
  }
  const created = valid.filter((i) => !existingIds.has(i.externalId)).length;
  return { created, updated: valid.length - created };
}

/** Roadmap metadata after an import (never written by gap analysis). */
export function importMetadata(
  previous: Prisma.JsonValue | null,
  info: { source: RoadmapImportSource; created: number; updated: number; skipped: number; truncated: boolean; options?: Record<string, string> }
): Prisma.InputJsonValue {
  const base = previous && typeof previous === "object" && !Array.isArray(previous) ? { ...(previous as Record<string, Prisma.JsonValue>) } : {};
  // Older rows stored CSV imports as MANUAL + importSource; the source column is authoritative now.
  delete base.importSource;
  return {
    ...base,
    ...(info.options ? { importOptions: info.options } : {}),
    lastImport: {
      at: new Date().toISOString(),
      source: info.source,
      created: info.created,
      updated: info.updated,
      skipped: info.skipped,
      truncated: info.truncated,
    },
  } as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Shared import path (router CSV imports and the background import worker)
// ---------------------------------------------------------------------------

export const INTEGRATION_ROADMAP_SOURCES = ["LINEAR", "JIRA", "NOTION", "PRODUCTBOARD"] as const;
export type IntegrationRoadmapSource = (typeof INTEGRATION_ROADMAP_SOURCES)[number];
export type RoadmapImportSource = "CSV" | IntegrationRoadmapSource;

export const SOURCE_LABEL: Record<RoadmapImportSource, string> = {
  CSV: "CSV",
  LINEAR: "Linear",
  JIRA: "Jira",
  NOTION: "Notion",
  PRODUCTBOARD: "Productboard",
};

const jobBase = {
  roadmapId: z.string().min(1).max(64).nullable(),
  name: z.string().trim().min(1).max(120).nullable(),
};

/** Validated parameters of an integration import (stored as JobRun.input, kind ROADMAP_IMPORT). */
export const roadmapImportJobInputSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("LINEAR"), ...jobBase, teamId: z.string().regex(LINEAR_ID).nullable() }),
  z.object({ source: z.literal("JIRA"), ...jobBase, projectKey: z.string().regex(JIRA_PROJECT_KEY) }),
  z.object({ source: z.literal("NOTION"), ...jobBase, databaseId: z.string().regex(NOTION_ID) }),
  z.object({ source: z.literal("PRODUCTBOARD"), ...jobBase }),
]);
export type RoadmapImportJobInput = z.infer<typeof roadmapImportJobInputSchema>;

/** Fetch items from the org's connected integration for a queued import. */
export async function fetchIntegrationRoadmapItems(
  orgId: string,
  params: RoadmapImportJobInput
): Promise<{ parsed: ParsedItems; options?: Record<string, string> }> {
  switch (params.source) {
    case "LINEAR":
      return {
        parsed: await fetchLinearItems(orgId, { teamId: params.teamId ?? undefined }),
        options: params.teamId ? { teamId: params.teamId } : undefined,
      };
    case "JIRA":
      return { parsed: await fetchJiraItems(orgId, { projectKey: params.projectKey }), options: { projectKey: params.projectKey } };
    case "NOTION":
      return { parsed: await fetchNotionItems(orgId, { databaseId: params.databaseId }), options: { databaseId: params.databaseId } };
    case "PRODUCTBOARD":
      return { parsed: await fetchProductboardItems(orgId) };
  }
}

export interface RoadmapImportResult {
  roadmapId: string;
  roadmapName: string;
  source: RoadmapImportSource;
  created: number;
  updated: number;
  skipped: ImportSkip[];
  skippedCount: number;
  truncated: boolean;
}

/**
 * Load items, then create (or reuse) the target roadmap, upsert the items on
 * (roadmapId, externalId) and record the import in metadata. Items are loaded
 * first so a failed fetch never leaves an empty roadmap behind. Idempotent:
 * a retry with the same `roadmapId` (see `onRoadmapCreated`) updates the same rows.
 */
export async function runRoadmapImport(input: {
  projectId: string;
  source: RoadmapImportSource;
  /** Existing roadmap in this project to import into, or null to create one. */
  roadmapId: string | null;
  name: string | null;
  load: () => Promise<{ parsed: ParsedItems; options?: Record<string, string> }>;
  /** Called right after a new roadmap is created (lets a retried job reuse it). */
  onRoadmapCreated?: (roadmapId: string) => Promise<void>;
}): Promise<RoadmapImportResult> {
  const label = SOURCE_LABEL[input.source];
  const { parsed, options } = await input.load();
  if (parsed.items.length === 0) throw new ImportError(`No roadmap items were found in the ${label} source`);

  let roadmap: { id: string; name: string; metadata: Prisma.JsonValue | null };
  let createdRoadmap = false;
  if (input.roadmapId) {
    const existing = await prisma.roadmap.findFirst({
      where: { id: input.roadmapId, projectId: input.projectId },
      select: { id: true, name: true, metadata: true },
    });
    if (!existing) throw new ImportError("The roadmap to import into no longer exists");
    roadmap = existing;
  } else {
    roadmap = await prisma.roadmap.create({
      data: {
        projectId: input.projectId,
        name: input.name ?? `${label} import ${new Date().toISOString().slice(0, 10)}`,
        source: input.source,
      },
      select: { id: true, name: true, metadata: true },
    });
    createdRoadmap = true;
    await input.onRoadmapCreated?.(roadmap.id);
  }

  const result = await upsertRoadmapItems(roadmap.id, parsed.items);
  await prisma.roadmap.update({
    where: { id: roadmap.id },
    data: {
      importedAt: new Date(),
      ...(createdRoadmap ? { source: input.source } : {}),
      metadata: importMetadata(roadmap.metadata, {
        source: input.source,
        created: result.created,
        updated: result.updated,
        skipped: parsed.skipped.length,
        truncated: parsed.truncated,
        options,
      }),
    },
  });
  return {
    roadmapId: roadmap.id,
    roadmapName: roadmap.name,
    source: input.source,
    created: result.created,
    updated: result.updated,
    skipped: parsed.skipped.slice(0, 50),
    skippedCount: parsed.skipped.length,
    truncated: parsed.truncated,
  };
}

/**
 * A user-presentable message for a failed import. Never includes upstream
 * response bodies: only our own error text, or a message chosen by status.
 */
export function importFailureMessage(err: unknown, label: string): string {
  if (err instanceof SafeFetchError) {
    if (err.code === "TIMEOUT") return `${label} took too long to respond. Please try again.`;
    if (err.code === "RESPONSE_TOO_LARGE") return `${label} returned more data than Beacon can import at once.`;
    return `${label} could not be reached. Please try again.`;
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    if (status === 401 || status === 403) return `${label} rejected the stored credentials. Reconnect the integration and try again.`;
    if (status === 404) return `${label} couldn't find what you asked to import. Check the import settings and try again.`;
    if (status === 429) return `${label} is rate limiting requests. Try again in a few minutes.`;
    return `${label} returned an error (${status}). Please try again.`;
  }
  if (err instanceof NonRetryableError) return err.message;
  return `The ${label} import failed. Please try again.`;
}
