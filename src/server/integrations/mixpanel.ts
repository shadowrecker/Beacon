/**
 * Mixpanel: daily product-usage summaries (top events, event and unique-user
 * counts) → OTHER documents, one per complete UTC day.
 *
 * Auth: service account (Basic) + project id, against the Query API of the
 * project's data residency region.
 */
import { z } from "zod";
import { basicAuth, type ProviderHttp } from "./http";
import { commonConfigShape, type Connector, type SyncRecord } from "./types";
import { cleanEventName, mapUsageDay, pendingDays, type DailyEventCounts } from "./usage-summary";

const BASES = { us: "https://mixpanel.com", eu: "https://eu.mixpanel.com", in: "https://in.mixpanel.com" } as const;

export const mixpanelCredentialSchema = z.object({
  serviceAccountUsername: z.string().trim().min(3).max(200).regex(/^[\w.@+-]+$/, "Invalid service account username"),
  serviceAccountSecret: z.string().trim().min(10, "Paste the service account secret").max(200),
  projectId: z.string().trim().regex(/^\d{1,20}$/, "Project IDs are numeric"),
});

export const mixpanelConfigSchema = z.object({
  region: z.enum(["us", "eu", "in"]).optional(),
  ...commonConfigShape,
});
type MixpanelConfig = z.infer<typeof mixpanelConfigSchema>;

const TOP_EVENTS = 15;
const DAYS_PER_SYNC = 14;

function base(config: MixpanelConfig): string {
  return BASES[config.region ?? "us"];
}

interface EventsResponse {
  data?: { series?: string[]; values?: Record<string, Record<string, number>> };
}

export function countsByEventDay(res: EventsResponse): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [event, byDay] of Object.entries(res.data?.values ?? {})) {
    const m = new Map<string, number>();
    for (const [day, v] of Object.entries(byDay ?? {})) m.set(day.slice(0, 10), Number.isFinite(Number(v)) ? Number(v) : 0);
    out.set(event, m);
  }
  return out;
}

export const mixpanelConnector: Connector<MixpanelConfig> = {
  provider: "MIXPANEL",
  auth: "apiKey",
  configSchema: mixpanelConfigSchema,
  credentialSchema: mixpanelCredentialSchema,
  authHeaders: (creds) => ({ authorization: basicAuth(creds.serviceAccountUsername ?? "", creds.serviceAccountSecret ?? "") }),

  async testConnection(http: ProviderHttp, creds, config) {
    await http.json(`${base(config)}/api/query/events/names`, { query: { project_id: creds.projectId, type: "general", limit: 1 } });
    return { accountLabel: `Mixpanel project ${creds.projectId}` };
  },

  async *sync(ctx) {
    const { days, more } = pendingDays(ctx.cursor, ctx.now, ctx.backfillDays, DAYS_PER_SYNC);
    if (days.length === 0) {
      yield { records: [], cursor: ctx.cursor, done: true };
      return;
    }
    const projectId = ctx.credentials.projectId;
    const names = await ctx.http.json<unknown>(`${base(ctx.config)}/api/query/events/names`, {
      query: { project_id: projectId, type: "general", limit: TOP_EVENTS },
    });
    const events = (Array.isArray(names) ? names : []).map(cleanEventName).filter((n): n is string => !!n).slice(0, TOP_EVENTS);

    let totals = new Map<string, Map<string, number>>();
    let uniques = new Map<string, Map<string, number>>();
    if (events.length > 0) {
      const query = (type: "general" | "unique") => ({
        project_id: projectId,
        event: JSON.stringify(events),
        type,
        unit: "day",
        from_date: days[0],
        to_date: days[days.length - 1],
      });
      totals = countsByEventDay(await ctx.http.json<EventsResponse>(`${base(ctx.config)}/api/query/events`, { query: query("general") }));
      uniques = countsByEventDay(await ctx.http.json<EventsResponse>(`${base(ctx.config)}/api/query/events`, { query: query("unique") }));
    }

    const records: SyncRecord[] = days.map((day) => {
      const rows: DailyEventCounts[] = events.map((e) => ({
        event: e,
        total: totals.get(e)?.get(day) ?? 0,
        uniques: uniques.get(e)?.get(day) ?? 0,
      }));
      return mapUsageDay("MIXPANEL", "Mixpanel", day, rows.filter((r) => r.total > 0));
    });
    yield { records, cursor: { lastDay: days[days.length - 1] }, done: !more };
  },
};
