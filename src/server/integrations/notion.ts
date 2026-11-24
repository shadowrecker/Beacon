/**
 * Notion: pages shared with the integration → NOTE documents.
 *
 * Auth: internal integration secret. The search endpoint can only sort by
 * last_edited_time, so pages are walked newest-first and the walk stops at the
 * previous high-water mark. Page bodies are read block by block with a request
 * budget per page (nested blocks two levels deep).
 */
import { z } from "zod";
import type { ProviderHttp } from "./http";
import { commonConfigShape, maxIso, readWindow, safeLink, toIso, type Connector, type SyncRecord } from "./types";

const API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

export const notionCredentialSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(20, "Paste the internal integration secret")
    .max(200)
    .regex(/^(secret_|ntn_)[A-Za-z0-9]+$/, "Notion secrets start with ntn_ or secret_"),
});

export const notionConfigSchema = z.object({
  /** Default database for roadmap import (src/server/ai/roadmap/importer.ts). */
  databaseId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i, "Use the 32-character database ID from its URL")
    .optional(),
  ...commonConfigShape,
});
type NotionConfig = z.infer<typeof notionConfigSchema>;

interface RichText {
  plain_text?: string;
}
export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}
export interface NotionPage {
  id: string;
  object: "page";
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, { type?: string; title?: RichText[] }>;
}

const TEXT_BLOCKS = new Set([
  "paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle",
  "quote", "callout", "code",
]);
const CONTAINER_BLOCKS = new Set(["toggle", "bulleted_list_item", "numbered_list_item", "column_list", "column", "synced_block", "callout", "quote", "to_do"]);

export function notionTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === "title") return (prop.title ?? []).map((t) => t.plain_text ?? "").join("").trim();
  }
  return "";
}

export function blockText(block: NotionBlock): string {
  if (!TEXT_BLOCKS.has(block.type)) return "";
  const payload = block[block.type] as { rich_text?: RichText[]; checked?: boolean } | undefined;
  const text = (payload?.rich_text ?? []).map((t) => t.plain_text ?? "").join("");
  if (!text.trim()) return "";
  switch (block.type) {
    case "heading_1":
    case "heading_2":
    case "heading_3":
      return `\n${text}\n`;
    case "bulleted_list_item":
    case "numbered_list_item":
      return `- ${text}`;
    case "to_do":
      return `[${payload?.checked ? "x" : " "}] ${text}`;
    case "quote":
      return `> ${text}`;
    default:
      return text;
  }
}

export function mapNotionPage(page: NotionPage, lines: string[]): SyncRecord {
  const title = notionTitle(page) || "Untitled Notion page";
  return {
    externalId: `page:${page.id}`,
    title,
    type: "NOTE",
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    sourceUrl: safeLink(page.url, ["notion.so", "notion.site"]),
    metadata: { provider: "NOTION", lastEditedAt: toIso(page.last_edited_time), createdAt: toIso(page.created_time) },
  };
}

const PAGE_SIZE = 25;
const BLOCK_REQUESTS_PER_PAGE = 8;
const MAX_DEPTH = 2;

async function readBlocks(http: ProviderHttp, pageId: string): Promise<string[]> {
  const lines: string[] = [];
  let budget = BLOCK_REQUESTS_PER_PAGE;
  const walk = async (blockId: string, depth: number): Promise<void> => {
    let cursor: string | null = null;
    do {
      if (budget-- <= 0) return;
      const res: { results?: NotionBlock[]; next_cursor?: string | null; has_more?: boolean } = await http.json(
        `${API}/blocks/${encodeURIComponent(blockId)}/children`,
        { query: { page_size: 100, start_cursor: cursor ?? undefined } }
      );
      for (const b of res.results ?? []) {
        const t = blockText(b);
        if (t) lines.push(depth > 0 ? `${"  ".repeat(depth)}${t}` : t);
        if (b.has_children && depth < MAX_DEPTH && CONTAINER_BLOCKS.has(b.type)) await walk(b.id, depth + 1);
      }
      cursor = res.has_more ? res.next_cursor ?? null : null;
    } while (cursor);
  };
  await walk(pageId, 0);
  return lines;
}

const cursorSchema = z.object({
  since: z.string().nullable(),
  after: z.string().max(2000).nullable(),
  highWater: z.string().nullable(),
});

export const notionConnector: Connector<NotionConfig> = {
  provider: "NOTION",
  auth: "apiKey",
  configSchema: notionConfigSchema,
  credentialSchema: notionCredentialSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.apiKey ?? creds.accessToken ?? ""}`, "notion-version": NOTION_VERSION }),

  async testConnection(http) {
    const me = await http.json<{ bot?: { workspace_name?: string }; name?: string }>(`${API}/users/me`);
    return { accountLabel: me.bot?.workspace_name ?? me.name ?? undefined };
  },

  async *sync(ctx) {
    const parsed = cursorSchema.safeParse(ctx.cursor);
    const win = parsed.success && parsed.data.since ? parsed.data : readWindow(null, ctx.now, ctx.backfillDays);
    const since = Date.parse(win.since!);
    let after = win.after;
    let highWater = win.highWater;
    let records = 0;

    for (let page = 0; page < ctx.limits.maxPages && records < ctx.limits.maxRecords; page++) {
      const res = await ctx.http.json<{ results?: NotionPage[]; next_cursor?: string | null; has_more?: boolean }>(`${API}/search`, {
        method: "POST",
        json: {
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: PAGE_SIZE,
          ...(after ? { start_cursor: after } : {}),
        },
      });
      const batch: SyncRecord[] = [];
      let reachedOld = false;
      for (const p of res.results ?? []) {
        const edited = toIso(p.last_edited_time);
        if (!edited || Date.parse(edited) <= since) {
          reachedOld = true;
          break;
        }
        highWater = maxIso(highWater, edited);
        if (p.object !== "page" || p.archived || p.in_trash) continue;
        batch.push(mapNotionPage(p, await readBlocks(ctx.http, p.id)));
      }
      records += batch.length;
      const next = !reachedOld && res.has_more ? res.next_cursor ?? null : null;
      const cursor = next ? { since: win.since, after: next, highWater } : { since: highWater ?? win.since, after: null, highWater: null };
      yield { records: batch, cursor, done: !next };
      if (!next) return;
      after = next;
    }
  },
};
