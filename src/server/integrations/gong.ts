/**
 * Gong: call transcripts with speaker names → TRANSCRIPT documents.
 *
 * Auth: OAuth (expiring access tokens, refreshed by the engine). The customer's
 * API host comes from the token response (`api_base_url_for_customer`) and is
 * validated against *.api.gong.io before use.
 */
import { z } from "zod";
import { NonRetryableError } from "../jobs/worker";
import type { ProviderHttp } from "./http";
import {
  advanceWindow,
  clip,
  commonConfigShape,
  maxIso,
  readWindow,
  safeLink,
  toIso,
  type Connector,
  type SyncRecord,
} from "./types";

/** Validate Gong's per-customer API base URL. */
export function gongBaseUrl(raw: string | undefined | null): string {
  try {
    const u = new URL(raw ?? "https://api.gong.io");
    const host = u.hostname.toLowerCase();
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      (u.pathname !== "/" && u.pathname !== "") ||
      !/^(?:[a-z0-9-]+\.)*api\.gong\.io$/.test(host)
    ) {
      throw new Error("bad");
    }
    return `https://${host}`;
  } catch {
    throw new NonRetryableError("Invalid Gong API host");
  }
}

export const gongConfigSchema = z.object({ ...commonConfigShape });
type GongConfig = z.infer<typeof gongConfigSchema>;

interface GongParty {
  speakerId?: string | null;
  name?: string | null;
  affiliation?: string | null;
}
export interface GongCall {
  metaData: { id: string; title?: string | null; started?: string; duration?: number; url?: string | null; direction?: string | null };
  parties?: GongParty[];
}
export interface GongTranscript {
  callId: string;
  transcript?: Array<{ speakerId?: string; topic?: string | null; sentences?: Array<{ start?: number; end?: number; text?: string }> }>;
}

export function mapGongCall(call: GongCall, transcript: GongTranscript | undefined): SyncRecord | null {
  const id = String(call.metaData.id);
  if (!/^\d{1,30}$/.test(id)) return null;
  const parties = new Map((call.parties ?? []).filter((p) => p.speakerId).map((p) => [String(p.speakerId), p]));
  const lines: string[] = [];
  const started = toIso(call.metaData.started);
  const header = [
    started ? `Call date: ${started.slice(0, 10)}` : null,
    call.metaData.duration ? `Duration: ${Math.round(call.metaData.duration / 60)} min` : null,
    parties.size ? `Participants: ${[...parties.values()].map((p) => p.name).filter(Boolean).slice(0, 20).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (header) lines.push(header);
  for (const mono of transcript?.transcript ?? []) {
    const text = (mono.sentences ?? []).map((s) => s.text?.trim()).filter(Boolean).join(" ");
    if (!text) continue;
    const party = mono.speakerId ? parties.get(String(mono.speakerId)) : undefined;
    const who = party?.name ? clip(party.name, 80) : `Speaker ${mono.speakerId ?? "?"}`;
    const side = party?.affiliation === "Internal" ? " (internal)" : party?.affiliation === "External" ? " (customer)" : "";
    lines.push(`${who}${side}: ${text}`);
  }
  if (lines.length <= 1 && !transcript) return null; // transcript not ready yet; picked up on a later sync
  return {
    externalId: `call:${id}`,
    title: call.metaData.title?.trim() || `Gong call ${started?.slice(0, 10) ?? id}`,
    type: "TRANSCRIPT",
    text: lines.join("\n\n"),
    sourceUrl: safeLink(call.metaData.url, ["gong.io"]),
    metadata: { provider: "GONG", startedAt: started, durationSec: call.metaData.duration ?? null },
  };
}

const TRANSCRIPT_BATCH = 20;

export const gongConnector: Connector<GongConfig> = {
  provider: "GONG",
  auth: "oauth",
  configSchema: gongConfigSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.accessToken ?? ""}` }),

  async testConnection(http: ProviderHttp, creds) {
    const base = gongBaseUrl(creds.apiBaseUrl);
    await http.request(`${base}/v2/calls`, {
      query: { fromDateTime: new Date(Date.now() - 86_400_000).toISOString() },
      acceptStatuses: [404], // "no calls found" is a successful auth check
    });
    return { accountLabel: new URL(base).hostname };
  },

  async *sync(ctx) {
    const base = gongBaseUrl(ctx.credentials.apiBaseUrl);
    let win = readWindow(ctx.cursor, ctx.now, ctx.backfillDays);
    let highWater = win.highWater;
    let records = 0;

    for (let page = 0; page < ctx.limits.maxPages && records < ctx.limits.maxRecords; page++) {
      const res = await ctx.http.request(`${base}/v2/calls/extensive`, {
        method: "POST",
        json: {
          filter: { fromDateTime: win.since },
          ...(win.after ? { cursor: win.after } : {}),
          contentSelector: { exposedFields: { parties: true } },
        },
        acceptStatuses: [404],
      });
      if (res.status === 404) {
        win = advanceWindow(win, null, highWater);
        yield { records: [], cursor: win, done: true };
        return;
      }
      const body = res.json<{ records?: { cursor?: string | null }; calls?: GongCall[] }>();
      const calls = (body.calls ?? []).filter((c) => c?.metaData?.id);

      const transcripts = new Map<string, GongTranscript>();
      for (let i = 0; i < calls.length; i += TRANSCRIPT_BATCH) {
        const ids = calls.slice(i, i + TRANSCRIPT_BATCH).map((c) => String(c.metaData.id));
        const tr = await ctx.http.request(`${base}/v2/calls/transcript`, {
          method: "POST",
          json: { filter: { callIds: ids } },
          acceptStatuses: [404],
          maxBytes: 20 * 1024 * 1024,
        });
        if (tr.status === 404) continue;
        for (const t of tr.json<{ callTranscripts?: GongTranscript[] }>().callTranscripts ?? []) {
          transcripts.set(String(t.callId), t);
        }
      }

      const batch: SyncRecord[] = [];
      for (const call of calls) {
        const rec = mapGongCall(call, transcripts.get(String(call.metaData.id)));
        if (rec) {
          batch.push(rec);
          highWater = maxIso(highWater, toIso(call.metaData.started));
        }
      }
      records += batch.length;
      const next = body.records?.cursor ?? null;
      const windowStart = win.since;
      win = advanceWindow(win, next, highWater);
      if (!next && win.since && windowStart) {
        // Transcripts appear some time after a call ends: overlap the next window by a day
        // so calls skipped for lack of a transcript are picked up (ingest is idempotent).
        win = { ...win, since: new Date(Math.max(Date.parse(windowStart), Date.parse(win.since) - 86_400_000)).toISOString() };
      }
      yield { records: batch, cursor: win, done: !next };
      if (!next) return;
      highWater = win.highWater;
    }
  },
};
