/**
 * HubSpot: service tickets → SUPPORT_TICKET documents.
 *
 * Auth: OAuth (30-minute access tokens, refreshed by the engine). Sync uses the
 * CRM search API filtered and sorted by hs_lastmodifieddate.
 */
import { z } from "zod";
import { htmlToText } from "../ai/competitive/html";
import type { ProviderHttp } from "./http";
import {
  advanceWindow,
  commonConfigShape,
  maxIso,
  readWindow,
  titleFrom,
  toIso,
  type Connector,
  type SyncRecord,
} from "./types";

const API = "https://api.hubapi.com";

export const hubspotConfigSchema = z.object({ ...commonConfigShape });
type HubSpotConfig = z.infer<typeof hubspotConfigSchema> & { account?: Record<string, string> };

const PROPERTIES = ["subject", "content", "hs_pipeline_stage", "hs_ticket_priority", "hs_ticket_category", "source_type", "createdate", "hs_lastmodifieddate"];

export interface HubSpotTicket {
  id: string;
  properties: Record<string, string | null | undefined>;
  createdAt?: string;
  updatedAt?: string;
}

export function mapHubSpotTicket(t: HubSpotTicket, portalId?: string): SyncRecord {
  const p = t.properties ?? {};
  const content = p.content ? htmlToText(p.content) : "";
  const header = [
    p.hs_ticket_priority ? `Priority: ${p.hs_ticket_priority}` : null,
    p.hs_ticket_category ? `Category: ${p.hs_ticket_category}` : null,
    p.source_type ? `Source: ${p.source_type}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const text = [header, content].filter(Boolean).join("\n\n");
  const id = String(t.id);
  return {
    externalId: `ticket:${id}`,
    title: p.subject?.trim() || titleFrom(content, `HubSpot ticket ${id}`),
    type: "SUPPORT_TICKET",
    text,
    sourceUrl: portalId && /^\d{1,20}$/.test(portalId) && /^\d{1,30}$/.test(id) ? `https://app.hubspot.com/contacts/${portalId}/ticket/${id}` : null,
    metadata: { provider: "HUBSPOT", priority: p.hs_ticket_priority ?? null, createdAt: toIso(p.createdate ?? t.createdAt) },
  };
}

export const hubspotConnector: Connector<HubSpotConfig> = {
  provider: "HUBSPOT",
  auth: "oauth",
  configSchema: hubspotConfigSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.accessToken ?? ""}` }),

  async testConnection(http: ProviderHttp, creds) {
    const info = await http.json<{ hub_id?: number; hub_domain?: string }>(
      `${API}/oauth/v1/access-tokens/${encodeURIComponent(creds.accessToken ?? "")}`,
      { noAuth: true }
    );
    return {
      accountLabel: info.hub_domain ?? undefined,
      account: info.hub_id ? { portalId: String(info.hub_id) } : undefined,
    };
  },

  async *sync(ctx) {
    let win = readWindow(ctx.cursor, ctx.now, ctx.backfillDays);
    let highWater = win.highWater;
    let records = 0;

    for (let page = 0; page < ctx.limits.maxPages && records < ctx.limits.maxRecords; page++) {
      const res = await ctx.http.json<{ results?: HubSpotTicket[]; paging?: { next?: { after?: string } } }>(
        `${API}/crm/v3/objects/tickets/search`,
        {
          method: "POST",
          json: {
            filterGroups: [
              { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GT", value: String(Date.parse(win.since!)) }] },
            ],
            sorts: [{ propertyName: "hs_lastmodifieddate", direction: "ASCENDING" }],
            properties: PROPERTIES,
            limit: 100,
            ...(win.after ? { after: win.after } : {}),
          },
        }
      );
      const batch: SyncRecord[] = [];
      for (const t of res.results ?? []) {
        if (!t?.id) continue;
        highWater = maxIso(highWater, toIso(t.properties?.hs_lastmodifieddate ?? t.updatedAt));
        batch.push(mapHubSpotTicket(t, ctx.config.account?.portalId));
      }
      records += batch.length;
      const next = res.paging?.next?.after ?? null;
      win = advanceWindow(win, next, highWater);
      yield { records: batch, cursor: win, done: !next };
      if (!next) return;
      highWater = win.highWater;
    }
  },
};
