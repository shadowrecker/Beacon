/**
 * Linear: issues with their comments → NOTE documents.
 *
 * Auth: personal API key (sent as-is in the Authorization header, as Linear
 * requires). GraphQL errors arrive with HTTP 200/400 and an `errors` array;
 * RATELIMITED is turned into a retryable 429, AUTHENTICATION_ERROR into a
 * reconnect error.
 */
import { z } from "zod";
import { ProviderAuthError, ProviderError, type ProviderHttp } from "./http";
import {
  advanceWindow,
  commonConfigShape,
  maxIso,
  readWindow,
  safeLink,
  toIso,
  type Connector,
  type SyncRecord,
} from "./types";

const API = "https://api.linear.app/graphql";

export const linearCredentialSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(20, "Paste a Linear personal API key")
    .max(200)
    .regex(/^lin_(api|oauth)_[A-Za-z0-9]+$/, "Linear API keys start with lin_api_"),
});

export const linearConfigSchema = z.object({
  /** Only sync issues from these team keys (e.g. ENG). */
  teamKeys: z.array(z.string().regex(/^[A-Z0-9]{1,10}$/, "Use team keys like ENG")).max(20).optional(),
  /** Team used by outbound issue creation (workflows, handoff). */
  teamId: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/).optional(),
  ...commonConfigShape,
});
type LinearConfig = z.infer<typeof linearConfigSchema>;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; extensions?: { code?: string; type?: string } }>;
}

export async function linearQuery<T>(http: ProviderHttp, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await http.request(API, { method: "POST", json: { query, variables }, acceptStatuses: [400] });
  const body = res.json<GraphQLResponse<T>>();
  if (body.errors?.length) {
    const codes = body.errors.map((e) => e.extensions?.code ?? e.extensions?.type ?? "").filter(Boolean);
    if (codes.includes("RATELIMITED")) throw new ProviderError("Linear rate limit reached; retrying later", "Linear", 429);
    if (codes.includes("AUTHENTICATION_ERROR") || codes.includes("authentication error")) throw new ProviderAuthError("Linear");
    throw new ProviderError("Linear rejected the query", "Linear", 400);
  }
  if (res.status === 400 || !body.data) throw new ProviderError("Linear request failed with status 400", "Linear", 400);
  return body.data;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  priorityLabel?: string | null;
  createdAt?: string;
  updatedAt?: string;
  state?: { name?: string } | null;
  team?: { key?: string; name?: string } | null;
  labels?: { nodes?: Array<{ name?: string }> } | null;
  creator?: { name?: string } | null;
  comments?: { nodes?: Array<{ body?: string | null; createdAt?: string; user?: { name?: string } | null }> } | null;
}

export function mapLinearIssue(i: LinearIssue): SyncRecord {
  const labels = (i.labels?.nodes ?? []).map((l) => l.name).filter((n): n is string => !!n).slice(0, 20);
  const header = [
    i.state?.name ? `Status: ${i.state.name}` : null,
    i.priorityLabel ? `Priority: ${i.priorityLabel}` : null,
    i.team?.name ? `Team: ${i.team.name}` : null,
    labels.length ? `Labels: ${labels.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [header, i.description?.trim() ? `${i.creator?.name ?? "Reporter"}: ${i.description.trim()}` : null];
  for (const c of i.comments?.nodes ?? []) {
    if (c.body?.trim()) lines.push(`${c.user?.name ?? "Comment"}: ${c.body.trim()}`);
  }
  return {
    externalId: `issue:${i.id}`,
    title: `${i.identifier}: ${i.title}`.slice(0, 300),
    type: "NOTE",
    text: lines.filter(Boolean).join("\n\n"),
    sourceUrl: safeLink(i.url, ["linear.app"]),
    metadata: { provider: "LINEAR", identifier: i.identifier, status: i.state?.name ?? null, labels, createdAt: toIso(i.createdAt) },
  };
}

const ISSUES_QUERY = `query BeaconIssues($after: String, $filter: IssueFilter) {
  issues(first: 50, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes {
      id identifier title description url priorityLabel createdAt updatedAt
      state { name } team { key name } creator { name }
      labels(first: 20) { nodes { name } }
      comments(first: 20) { nodes { body createdAt user { name } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const linearConnector: Connector<LinearConfig> = {
  provider: "LINEAR",
  auth: "apiKey",
  configSchema: linearConfigSchema,
  credentialSchema: linearCredentialSchema,
  authHeaders: (creds) => ({ authorization: creds.apiKey ?? creds.accessToken ?? "" }),

  async testConnection(http) {
    const data = await linearQuery<{ viewer?: { name?: string }; organization?: { name?: string } }>(
      http,
      "query { viewer { name } organization { name } }",
      {}
    );
    return { accountLabel: data.organization?.name ?? data.viewer?.name ?? undefined };
  },

  async *sync(ctx) {
    let win = readWindow(ctx.cursor, ctx.now, ctx.backfillDays);
    let highWater = win.highWater;
    let records = 0;
    const filter: Record<string, unknown> = { updatedAt: { gt: win.since } };
    if (ctx.config.teamKeys?.length) filter.team = { key: { in: ctx.config.teamKeys } };

    for (let page = 0; page < ctx.limits.maxPages && records < ctx.limits.maxRecords; page++) {
      const data = await linearQuery<{ issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } } }>(
        ctx.http,
        ISSUES_QUERY,
        { after: win.after, filter }
      );
      const batch: SyncRecord[] = [];
      for (const issue of data.issues?.nodes ?? []) {
        if (!issue?.id) continue;
        highWater = maxIso(highWater, toIso(issue.updatedAt));
        batch.push(mapLinearIssue(issue));
      }
      records += batch.length;
      const next = data.issues?.pageInfo?.hasNextPage ? data.issues.pageInfo.endCursor ?? null : null;
      win = advanceWindow(win, next, highWater);
      yield { records: batch, cursor: win, done: !next };
      if (!next) return;
      highWater = win.highWater;
    }
  },
};
