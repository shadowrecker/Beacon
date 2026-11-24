/**
 * Amplitude: daily product-usage summaries (top events, event and unique-user
 * counts) → OTHER documents, one per complete UTC day.
 *
 * Auth: project API key + secret key (Basic) against the Dashboard REST API.
 */
import { z } from "zod";
import { basicAuth, type ProviderHttp } from "./http";
import { commonConfigShape, type Connector, type SyncRecord } from "./types";
import { cleanEventName, mapUsageDay, pendingDays, type DailyEventCounts } from "./usage-summary";

const BASES = { us: "https://amplitude.com", eu: "https://analytics.eu.amplitude.com" } as const;

export const amplitudeCredentialSchema = z.object({
  apiKey: z.string().trim().regex(/^[a-f0-9]{32}$/i, "Amplitude API keys are 32 hex characters"),
  secretKey: z.string().trim().regex(/^[a-f0-9]{32}$/i, "Amplitude secret keys are 32 hex characters"),
});

export const amplitudeConfigSchema = z.object({
  region: z.enum(["us", "eu"]).optional(),
  ...commonConfigShape,
});
type AmplitudeConfig = z.infer<typeof amplitudeConfigSchema>;

const TOP_EVENTS = 15;
const DAYS_PER_SYNC = 14;

function base(config: AmplitudeConfig): string {
  return BASES[config.region ?? "us"];
}

const compact = (day: string) => day.replace(/-/g, "");

interface Segmentation {
  data?: { series?: number[][]; xValues?: string[] };
}

export function seriesByDay(seg: Segmentation): Map<string, number> {
  const out = new Map<string, number>();
  const xs = seg.data?.xValues ?? [];
  const ys = seg.data?.series?.[0] ?? [];
  xs.forEach((x, i) => {
    const v = Number(ys[i] ?? 0);
    out.set(String(x).slice(0, 10), Number.isFinite(v) ? v : 0);
  });
  return out;
}

export const amplitudeConnector: Connector<AmplitudeConfig> = {
  provider: "AMPLITUDE",
  auth: "apiKey",
  configSchema: amplitudeConfigSchema,
  credentialSchema: amplitudeCredentialSchema,
  authHeaders: (creds) => ({ authorization: basicAuth(creds.apiKey ?? "", creds.secretKey ?? "") }),

  async testConnection(http: ProviderHttp, _creds, config) {
    await http.json(`${base(config)}/api/2/events/list`);
    return { accountLabel: `Amplitude (${(config.region ?? "us").toUpperCase()})` };
  },

  async *sync(ctx) {
    const { days, more } = pendingDays(ctx.cursor, ctx.now, ctx.backfillDays, DAYS_PER_SYNC);
    if (days.length === 0) {
      yield { records: [], cursor: ctx.cursor, done: true };
      return;
    }
    const list = await ctx.http.json<{ data?: Array<{ value?: string; totals?: number; deleted?: boolean; hidden?: boolean }> }>(
      `${base(ctx.config)}/api/2/events/list`
    );
    const events = (list.data ?? [])
      .filter((e) => !e.deleted && !e.hidden)
      .map((e) => ({ name: cleanEventName(e.value), totals: Number(e.totals ?? 0) }))
      .filter((e): e is { name: string; totals: number } => !!e.name)
      .sort((a, b) => b.totals - a.totals)
      .slice(0, TOP_EVENTS);

    const totals = new Map<string, Map<string, number>>();
    const uniques = new Map<string, Map<string, number>>();
    const start = compact(days[0]);
    const end = compact(days[days.length - 1]);
    for (const e of events) {
      for (const [metric, target] of [["totals", totals], ["uniques", uniques]] as const) {
        const seg = await ctx.http.json<Segmentation>(`${base(ctx.config)}/api/2/events/segmentation`, {
          query: { e: JSON.stringify({ event_type: e.name }), start, end, m: metric, i: 1 },
        });
        target.set(e.name, seriesByDay(seg));
      }
    }

    const records: SyncRecord[] = days.map((day) => {
      const rows: DailyEventCounts[] = events.map((e) => ({
        event: e.name,
        total: totals.get(e.name)?.get(day) ?? 0,
        uniques: uniques.get(e.name)?.get(day) ?? 0,
      }));
      return mapUsageDay("AMPLITUDE", "Amplitude", day, rows.filter((r) => r.total > 0));
    });
    yield { records, cursor: { lastDay: days[days.length - 1] }, done: !more };
  },
};
