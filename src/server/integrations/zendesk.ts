/**
 * Zendesk: tickets with their comment thread → SUPPORT_TICKET documents.
 *
 * Auth: OAuth on the customer's own subdomain (PKCE). The subdomain is validated
 * against a strict pattern before any URL is built, so a crafted value can never
 * redirect the token to another host. Sync uses the cursor-based
 * incremental ticket export, whose `after_cursor` is the incremental marker.
 */
import { z } from "zod";
import { NonRetryableError } from "../jobs/worker";
import { htmlToText } from "../ai/competitive/html";
import type { ProviderHttp } from "./http";
import { clip, commonConfigShape, titleFrom, toIso, type Connector, type SyncRecord } from "./types";

const SUBDOMAIN = /^[a-z0-9-]+$/;
const SUBDOMAIN_STRICT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Validate a Zendesk subdomain ("acme" for acme.zendesk.com). Throws on anything else. */
export function zendeskSubdomain(raw: string | undefined | null): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (!SUBDOMAIN.test(s) || !SUBDOMAIN_STRICT.test(s)) throw new NonRetryableError("Invalid Zendesk subdomain");
  return s;
}

export function zendeskBaseUrl(subdomain: string | undefined | null): string {
  return `https://${zendeskSubdomain(subdomain)}.zendesk.com`;
}

export const zendeskConfigSchema = z.object({ ...commonConfigShape });
type ZendeskConfig = z.infer<typeof zendeskConfigSchema> & { account?: Record<string, string> };

const cursorSchema = z.object({ afterCursor: z.string().min(1).max(2000) });

const PER_PAGE = 100;

export interface ZendeskTicket {
  id: number;
  subject?: string | null;
  description?: string | null;
  status?: string;
  priority?: string | null;
  type?: string | null;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}
export interface ZendeskComment {
  author_id?: number;
  body?: string;
  plain_body?: string;
  html_body?: string;
  public?: boolean;
  created_at?: string;
}
interface ZendeskUser {
  id: number;
  name?: string;
  role?: string;
}

export function mapZendeskTicket(
  t: ZendeskTicket,
  comments: ZendeskComment[],
  users: ZendeskUser[],
  subdomain: string
): SyncRecord {
  const byId = new Map(users.map((u) => [u.id, u]));
  const header = [
    t.status ? `Status: ${t.status}` : null,
    t.priority ? `Priority: ${t.priority}` : null,
    t.type ? `Type: ${t.type}` : null,
    t.tags?.length ? `Tags: ${t.tags.slice(0, 20).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines: string[] = header ? [header] : [];
  if (comments.length > 0) {
    for (const c of comments) {
      const body = c.plain_body ?? (c.html_body ? htmlToText(c.html_body) : c.body ?? "");
      if (!body.trim()) continue;
      const user = c.author_id !== undefined ? byId.get(c.author_id) : undefined;
      const who = user?.role === "end-user" || !user ? "Customer" : "Agent";
      const name = user?.name ? ` (${clip(user.name, 80)})` : "";
      lines.push(`${who}${name}${c.public === false ? " [internal note]" : ""}: ${body.trim()}`);
    }
  } else if (t.description) {
    lines.push(`Customer: ${t.description.trim()}`);
  }
  const text = lines.join("\n\n");
  return {
    externalId: `ticket:${t.id}`,
    title: t.subject?.trim() || titleFrom(t.description ?? "", `Zendesk ticket #${t.id}`),
    type: "SUPPORT_TICKET",
    text,
    sourceUrl: `https://${subdomain}.zendesk.com/agent/tickets/${t.id}`,
    metadata: {
      provider: "ZENDESK",
      status: t.status ?? null,
      priority: t.priority ?? null,
      tags: (t.tags ?? []).slice(0, 20),
      createdAt: toIso(t.created_at),
    },
  };
}

export const zendeskConnector: Connector<ZendeskConfig> = {
  provider: "ZENDESK",
  auth: "oauth",
  configSchema: zendeskConfigSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.accessToken ?? ""}` }),

  async testConnection(http: ProviderHttp, creds) {
    const base = zendeskBaseUrl(creds.subdomain);
    const me = await http.json<{ user?: { name?: string } }>(`${base}/api/v2/users/me.json`);
    return { accountLabel: `${zendeskSubdomain(creds.subdomain)}.zendesk.com${me.user?.name ? ` (${me.user.name})` : ""}` };
  },

  async *sync(ctx) {
    const subdomain = zendeskSubdomain(ctx.credentials.subdomain);
    const base = `https://${subdomain}.zendesk.com`;
    const parsed = cursorSchema.safeParse(ctx.cursor);
    let afterCursor = parsed.success ? parsed.data.afterCursor : null;
    // start_time must be at least a minute in the past.
    const startTime = Math.min(
      Math.floor(ctx.now.getTime() / 1000) - 120,
      Math.floor((ctx.now.getTime() - ctx.backfillDays * 86_400_000) / 1000)
    );
    const maxPages = Math.min(ctx.limits.maxPages, 3);
    let records = 0;

    for (let page = 0; page < maxPages && records < ctx.limits.maxRecords; page++) {
      const res = await ctx.http.json<{
        tickets?: ZendeskTicket[];
        after_cursor?: string | null;
        end_of_stream?: boolean;
      }>(`${base}/api/v2/incremental/tickets/cursor.json`, {
        query: afterCursor ? { cursor: afterCursor, per_page: PER_PAGE } : { start_time: startTime, per_page: PER_PAGE },
      });

      const batch: SyncRecord[] = [];
      for (const t of res.tickets ?? []) {
        if (!Number.isInteger(t.id) || t.status === "deleted") continue;
        const comments = await ctx.http.request(`${base}/api/v2/tickets/${t.id}/comments.json`, {
          query: { include: "users", "page[size]": 100 },
          acceptStatuses: [404],
        });
        const body =
          comments.status === 404 ? { comments: [], users: [] } : comments.json<{ comments?: ZendeskComment[]; users?: ZendeskUser[] }>();
        batch.push(mapZendeskTicket(t, body.comments ?? [], body.users ?? [], subdomain));
      }
      records += batch.length;
      afterCursor = res.after_cursor ?? afterCursor;
      const done = res.end_of_stream !== false;
      yield { records: batch, cursor: afterCursor ? { afterCursor } : ctx.cursor, done };
      if (done) return;
    }
  },
};
