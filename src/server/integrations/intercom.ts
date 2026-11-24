/**
 * Intercom: conversations (customer messages and replies) → SUPPORT_TICKET documents.
 *
 * Auth: OAuth (tokens do not expire). API: conversations search filtered by
 * updated_at, then each conversation's parts as plain text. Regional workspaces
 * (EU, AU) use their own API host.
 */
import { z } from "zod";
import { htmlToText } from "../ai/competitive/html";
import type { ProviderHttp } from "./http";
import {
  advanceWindow,
  clip,
  commonConfigShape,
  maxIso,
  readWindow,
  titleFrom,
  toIso,
  type Connector,
  type SyncRecord,
} from "./types";

const BASES = {
  us: "https://api.intercom.io",
  eu: "https://api.eu.intercom.io",
  au: "https://api.au.intercom.io",
} as const;

export const intercomConfigSchema = z.object({
  region: z.enum(["us", "eu", "au"]).optional(),
  ...commonConfigShape,
});
type IntercomConfig = z.infer<typeof intercomConfigSchema> & { account?: Record<string, string> };

const PER_PAGE = 25;

interface Author {
  type?: string;
  name?: string | null;
}
interface IntercomPart {
  part_type?: string;
  body?: string | null;
  author?: Author;
  created_at?: number;
}
export interface IntercomConversation {
  id: string;
  title?: string | null;
  created_at?: number;
  updated_at?: number;
  state?: string;
  source?: { subject?: string | null; body?: string | null; author?: Author; url?: string | null };
  tags?: { tags?: Array<{ name?: string }> };
  conversation_parts?: { conversation_parts?: IntercomPart[] };
}

function authorLabel(a: Author | undefined): string {
  const name = a?.name ? ` (${clip(a.name, 80)})` : "";
  if (a?.type === "admin" || a?.type === "bot" || a?.type === "team") return `Agent${name}`;
  return `Customer${name}`;
}

export function mapIntercomConversation(c: IntercomConversation, appId?: string): SyncRecord {
  const lines: string[] = [];
  const src = c.source ?? {};
  if (src.body) lines.push(`${authorLabel(src.author)}: ${htmlToText(src.body)}`);
  for (const p of c.conversation_parts?.conversation_parts ?? []) {
    if (!p.body) continue;
    const note = p.part_type === "note" ? " [internal note]" : "";
    lines.push(`${authorLabel(p.author)}${note}: ${htmlToText(p.body)}`);
  }
  const text = lines.join("\n\n");
  const subject = src.subject ? htmlToText(src.subject) : "";
  const id = String(c.id);
  const tags = (c.tags?.tags ?? []).map((t) => t.name).filter((t): t is string => !!t).slice(0, 20);
  return {
    externalId: `conversation:${id}`,
    title: subject || c.title || titleFrom(text, `Intercom conversation ${id}`),
    type: "SUPPORT_TICKET",
    text,
    sourceUrl:
      appId && /^[a-z0-9]{1,32}$/.test(appId) && /^\d{1,30}$/.test(id)
        ? `https://app.intercom.com/a/apps/${appId}/inbox/inbox/conversation/${id}`
        : null,
    metadata: { provider: "INTERCOM", state: c.state ?? null, tags, createdAt: toIso(c.created_at) },
  };
}

function base(config: IntercomConfig): string {
  return BASES[config.region ?? "us"];
}

export const intercomConnector: Connector<IntercomConfig> = {
  provider: "INTERCOM",
  auth: "oauth",
  configSchema: intercomConfigSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.accessToken ?? ""}`, "intercom-version": "2.11" }),

  async testConnection(http: ProviderHttp, _creds, config) {
    const me = await http.json<{ email?: string; app?: { id_code?: string; name?: string } }>(`${base(config)}/me`);
    const appId = me.app?.id_code;
    return {
      accountLabel: me.app?.name ?? undefined,
      account: appId && /^[a-z0-9]{1,32}$/.test(appId) ? { appId } : undefined,
    };
  },

  async *sync(ctx) {
    let win = readWindow(ctx.cursor, ctx.now, ctx.backfillDays);
    const sinceUnix = Math.floor(Date.parse(win.since!) / 1000);
    let highWater = win.highWater;
    let pages = 0;
    let records = 0;
    const maxRecords = Math.min(ctx.limits.maxRecords, 200);

    while (pages < ctx.limits.maxPages && records < maxRecords) {
      const page = await ctx.http.json<{
        conversations?: Array<{ id: string; updated_at?: number }>;
        pages?: { next?: { starting_after?: string | null } | null };
      }>(`${base(ctx.config)}/conversations/search`, {
        method: "POST",
        json: {
          query: { field: "updated_at", operator: ">", value: sinceUnix },
          pagination: { per_page: PER_PAGE, ...(win.after ? { starting_after: win.after } : {}) },
        },
      });
      pages++;

      const batch: SyncRecord[] = [];
      for (const summary of page.conversations ?? []) {
        if (!/^\d{1,30}$/.test(String(summary.id))) continue;
        highWater = maxIso(highWater, toIso(summary.updated_at));
        const detail = await ctx.http.json<IntercomConversation>(
          `${base(ctx.config)}/conversations/${encodeURIComponent(summary.id)}`,
          { query: { display_as: "plaintext" } }
        );
        batch.push(mapIntercomConversation(detail, ctx.config.account?.appId));
      }
      records += batch.length;
      const next = page.pages?.next?.starting_after ?? null;
      win = advanceWindow(win, next, highWater);
      yield { records: batch, cursor: win, done: !next };
      if (!next) return;
      highWater = win.highWater;
    }
  },
};
