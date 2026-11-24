/**
 * Slack: messages (with their thread replies) from selected channels → NOTE documents.
 *
 * Auth: OAuth v2 bot token (optional token rotation, refreshed by the engine).
 * Each top-level message becomes one document (externalId channel:ts) holding
 * the message and up to 200 replies. Channels are the configured `channelIds`,
 * or the public channels the bot is a member of.
 *
 * Slack returns HTTP 200 with `ok: false` for errors, so responses are checked
 * here: `ratelimited` becomes a retryable 429, auth errors require reconnecting.
 */
import { z } from "zod";
import { ProviderAuthError, ProviderError, type ProviderHttp } from "./http";
import { clip, commonConfigShape, titleFrom, type Connector, type SyncRecord } from "./types";

const API = "https://slack.com/api";
const CHANNEL_ID = /^[CG][A-Z0-9]{6,20}$/;
const SLACK_CHANNEL = /^[CGD][A-Z0-9]{6,}$|^#[a-z0-9_-]{1,80}$/;

export const slackConfigSchema = z.object({
  channelIds: z.array(z.string().regex(CHANNEL_ID, "Use Slack channel IDs (e.g. C0123456789)")).max(20).optional(),
  /** Channel used by outbound notifications (workflows). */
  defaultChannel: z.string().regex(SLACK_CHANNEL, "Use a channel ID or #channel-name").optional(),
  ...commonConfigShape,
});
type SlackConfig = z.infer<typeof slackConfigSchema>;

const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "no_permission"]);

export async function slackCall<T extends { ok: boolean; error?: string }>(
  http: ProviderHttp,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  opts: { post?: boolean; tolerate?: string[] } = {}
): Promise<T> {
  const body = await http.json<T>(`${API}/${method}`, opts.post ? { method: "POST", form: stringify(params) } : { query: params });
  if (!body.ok) {
    const code = body.error ?? "unknown_error";
    if (opts.tolerate?.includes(code)) return body;
    if (code === "ratelimited") throw new ProviderError("Slack rate limit reached; retrying later", "Slack", 429);
    if (AUTH_ERRORS.has(code)) throw new ProviderAuthError("Slack", code);
    throw new ProviderError(`Slack ${method} failed (${/^[a-z_]{1,60}$/.test(code) ? code : "error"})`, "Slack", 400);
  }
  return body;
}

function stringify(params: Record<string, string | number | boolean | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? undefined : String(v);
  return out;
}

/** Convert Slack mrkdwn to plain text. */
export function slackToText(text: string, users: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${label ?? users.get(id) ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id: string, label?: string) => `#${label || id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, label?: string) => label ?? "@group")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  thread_ts?: string;
}

const KEEP_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);

export function isHumanMessage(m: SlackMessage): boolean {
  return !m.bot_id && KEEP_SUBTYPES.has(m.subtype) && !!m.text?.trim();
}

export function mapSlackThread(
  channel: { id: string; name: string },
  parent: SlackMessage,
  replies: SlackMessage[],
  users: Map<string, string>
): SyncRecord {
  const who = (m: SlackMessage) => (m.user ? users.get(m.user) ?? m.user : "Unknown");
  const lines = [`${who(parent)}: ${slackToText(parent.text ?? "", users)}`];
  for (const r of replies) {
    if (r.ts === parent.ts || !isHumanMessage(r)) continue;
    lines.push(`  ↳ ${who(r)}: ${slackToText(r.text ?? "", users)}`);
  }
  const text = lines.join("\n");
  const first = slackToText(parent.text ?? "", users);
  return {
    externalId: `${channel.id}:${parent.ts}`,
    title: `#${clip(channel.name, 60)}: ${titleFrom(first, "Slack message", 100)}`,
    type: "NOTE",
    text,
    sourceUrl: /^\d+\.\d+$/.test(parent.ts) ? `https://slack.com/archives/${channel.id}/p${parent.ts.replace(".", "")}` : null,
    metadata: {
      provider: "SLACK",
      channel: channel.name,
      postedAt: new Date(Number(parent.ts) * 1000).toISOString(),
      replies: Math.max(0, lines.length - 1),
    },
  };
}

/** Per-channel window over Slack timestamps ("1700000000.000100"). */
const channelCursorSchema = z.object({
  oldest: z.string().regex(/^\d+(\.\d+)?$/),
  after: z.string().max(2000).nullable(),
  highWater: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
});
const cursorSchema = z.object({ channels: z.record(z.string(), channelCursorSchema) });
type ChannelCursor = z.infer<typeof channelCursorSchema>;

function maxTs(a: string | null, b: string | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return Number(b) > Number(a) ? b : a;
}

const MAX_CHANNELS = 20;
const PAGES_PER_CHANNEL = 3;
const THREADS_PER_SYNC = 60;
const USER_LOOKUPS = 60;

export const slackConnector: Connector<SlackConfig> = {
  provider: "SLACK",
  auth: "oauth",
  configSchema: slackConfigSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.botToken ?? creds.accessToken ?? ""}` }),

  async testConnection(http) {
    const res = await slackCall<{ ok: boolean; team?: string; team_id?: string }>(http, "auth.test", {}, { post: true });
    return { accountLabel: res.team ?? undefined, account: res.team_id ? { teamId: res.team_id } : undefined };
  },

  async *sync(ctx) {
    const parsed = cursorSchema.safeParse(ctx.cursor);
    const cursor: Record<string, ChannelCursor> = parsed.success ? { ...parsed.data.channels } : {};
    const users = new Map<string, string>();
    let userLookups = 0;
    let threadBudget = THREADS_PER_SYNC;

    const resolveUser = async (id: string | undefined) => {
      if (!id || users.has(id) || userLookups >= USER_LOOKUPS) return;
      userLookups++;
      const res = await slackCall<{ ok: boolean; error?: string; user?: { real_name?: string; name?: string; profile?: { display_name?: string } } }>(
        ctx.http,
        "users.info",
        { user: id },
        { tolerate: ["user_not_found", "missing_scope"] }
      );
      const name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name;
      users.set(id, name ? clip(name, 80) : id);
    };

    // Channels to sync.
    let channels: Array<{ id: string; name: string }> = [];
    if (ctx.config.channelIds?.length) {
      for (const id of ctx.config.channelIds.slice(0, MAX_CHANNELS)) {
        const info = await slackCall<{ ok: boolean; error?: string; channel?: { id: string; name?: string; is_member?: boolean } }>(
          ctx.http,
          "conversations.info",
          { channel: id },
          { tolerate: ["channel_not_found"] }
        );
        if (!info.channel) continue;
        if (info.channel.is_member === false) {
          await slackCall(ctx.http, "conversations.join", { channel: id }, { post: true, tolerate: ["method_not_supported_for_channel_type", "missing_scope", "is_archived"] });
        }
        channels.push({ id, name: info.channel.name ?? id });
      }
    } else {
      const res = await slackCall<{ ok: boolean; channels?: Array<{ id: string; name?: string }> }>(ctx.http, "users.conversations", {
        types: "public_channel",
        exclude_archived: true,
        limit: 200,
      });
      channels = (res.channels ?? [])
        .filter((c) => CHANNEL_ID.test(c.id))
        .slice(0, MAX_CHANNELS)
        .map((c) => ({ id: c.id, name: c.name ?? c.id }));
    }

    let records = 0;
    let more = false;
    const defaultOldest = String(Math.floor((ctx.now.getTime() - ctx.backfillDays * 86_400_000) / 1000));

    for (let ci = 0; ci < channels.length; ci++) {
      const channel = channels[ci];
      let w: ChannelCursor = cursor[channel.id] ?? { oldest: defaultOldest, after: null, highWater: null };

      for (let page = 0; page < PAGES_PER_CHANNEL && records < ctx.limits.maxRecords; page++) {
        const res = await slackCall<{
          ok: boolean;
          error?: string;
          messages?: SlackMessage[];
          has_more?: boolean;
          response_metadata?: { next_cursor?: string };
        }>(
          ctx.http,
          "conversations.history",
          { channel: channel.id, oldest: w.oldest, limit: 200, ...(w.after ? { cursor: w.after } : {}) },
          { tolerate: ["not_in_channel", "channel_not_found"] }
        );
        if (!res.ok) break; // bot not in channel: nothing readable yet

        const batch: SyncRecord[] = [];
        let highWater = w.highWater;
        for (const m of res.messages ?? []) {
          if (!/^\d+\.\d+$/.test(m.ts)) continue;
          highWater = maxTs(highWater, m.ts);
          if (!isHumanMessage(m) || (m.thread_ts && m.thread_ts !== m.ts && m.subtype !== "thread_broadcast")) continue;
          await resolveUser(m.user);
          let replies: SlackMessage[] = [];
          if ((m.reply_count ?? 0) > 0 && threadBudget > 0) {
            threadBudget--;
            const r = await slackCall<{ ok: boolean; error?: string; messages?: SlackMessage[] }>(
              ctx.http,
              "conversations.replies",
              { channel: channel.id, ts: m.ts, limit: 200 },
              { tolerate: ["thread_not_found"] }
            );
            replies = r.messages ?? [];
            for (const reply of replies.slice(0, 20)) await resolveUser(reply.user);
          }
          batch.push(mapSlackThread(channel, m, replies, users));
        }
        records += batch.length;
        const next = res.has_more ? res.response_metadata?.next_cursor || null : null;
        w = next ? { oldest: w.oldest, after: next, highWater } : { oldest: highWater ?? w.oldest, after: null, highWater: null };
        cursor[channel.id] = w;
        const lastChannel = ci === channels.length - 1;
        yield { records: batch, cursor: { channels: cursor }, done: !next && lastChannel && !more };
        if (!next) break;
      }
      if (w.after) more = true;
      if (records >= ctx.limits.maxRecords) {
        yield { records: [], cursor: { channels: cursor }, done: false };
        return;
      }
    }
    yield { records: [], cursor: { channels: cursor }, done: !more };
  },
};
