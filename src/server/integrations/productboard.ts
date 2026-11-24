/**
 * Productboard: customer feedback notes → NOTE documents.
 *
 * Auth: public API access token (Bearer, X-Version: 1). Sync lists notes
 * updated since the window start, paginated with pageCursor.
 */
import { z } from "zod";
import { htmlToText } from "../ai/competitive/html";
import type { ProviderHttp } from "./http";
import {
  advanceWindow,
  commonConfigShape,
  maxIso,
  readWindow,
  safeLink,
  titleFrom,
  toIso,
  type Connector,
  type SyncRecord,
} from "./types";

const API = "https://api.productboard.com";

export const productboardCredentialSchema = z.object({
  apiToken: z.string().trim().min(20, "Paste a Productboard access token").max(2000).regex(/^[A-Za-z0-9._-]+$/, "Invalid token format"),
});

export const productboardConfigSchema = z.object({ ...commonConfigShape });
type ProductboardConfig = z.infer<typeof productboardConfigSchema>;

export interface ProductboardNote {
  id: string;
  title?: string | null;
  content?: string | null;
  displayUrl?: string | null;
  state?: string | null;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  user?: { name?: string | null; email?: string | null } | null;
  company?: { name?: string | null } | null;
  source?: { origin?: string | null } | null;
}

export function mapProductboardNote(n: ProductboardNote): SyncRecord {
  const body = n.content ? htmlToText(n.content) : "";
  const who = n.user?.name || "Customer";
  const header = [
    n.company?.name ? `Company: ${n.company.name}` : null,
    n.source?.origin ? `Source: ${n.source.origin}` : null,
    n.tags?.length ? `Tags: ${n.tags.slice(0, 20).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    externalId: `note:${n.id}`,
    title: n.title?.trim() || titleFrom(body, "Productboard note"),
    type: "NOTE",
    text: [header, body ? `${who}: ${body}` : null].filter(Boolean).join("\n\n"),
    sourceUrl: safeLink(n.displayUrl, ["productboard.com"]),
    metadata: { provider: "PRODUCTBOARD", state: n.state ?? null, tags: (n.tags ?? []).slice(0, 20), createdAt: toIso(n.createdAt) },
  };
}

export const productboardConnector: Connector<ProductboardConfig> = {
  provider: "PRODUCTBOARD",
  auth: "apiKey",
  configSchema: productboardConfigSchema,
  credentialSchema: productboardCredentialSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.apiToken ?? ""}`, "x-version": "1" }),

  async testConnection(http: ProviderHttp) {
    await http.json(`${API}/notes`, { query: { pageLimit: 1 } });
    return {};
  },

  async *sync(ctx) {
    let win = readWindow(ctx.cursor, ctx.now, ctx.backfillDays);
    let highWater = win.highWater;
    let records = 0;

    for (let page = 0; page < ctx.limits.maxPages && records < ctx.limits.maxRecords; page++) {
      const res = await ctx.http.json<{ data?: ProductboardNote[]; pageCursor?: string | null }>(`${API}/notes`, {
        query: { updatedFrom: win.since, pageLimit: 100, pageCursor: win.after ?? undefined },
      });
      const batch: SyncRecord[] = [];
      for (const note of res.data ?? []) {
        if (!note?.id) continue;
        highWater = maxIso(highWater, toIso(note.updatedAt));
        batch.push(mapProductboardNote(note));
      }
      records += batch.length;
      const next = res.pageCursor || null;
      win = advanceWindow(win, next, highWater);
      yield { records: batch, cursor: win, done: !next };
      if (!next) return;
      highWater = win.highWater;
    }
  },
};
