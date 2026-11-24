/**
 * Salesforce: Cases with their comments → SUPPORT_TICKET documents.
 *
 * Auth: OAuth web-server flow with PKCE. The `instance_url` returned by
 * Salesforce is validated (https, *.salesforce.com / *.my.salesforce.com, no
 * port, path or credentials) before any request is built from it, so a tampered
 * value can never redirect the bearer token to another host. Access
 * tokens have no fixed lifetime: a 401 triggers a refresh-token grant.
 */
import { z } from "zod";
import { NonRetryableError } from "../jobs/worker";
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

export const SALESFORCE_API_VERSION = "v62.0";

/** Validate a Salesforce instance URL and return its origin. Throws on anything else. */
export function salesforceInstanceUrl(raw: string | undefined | null): string {
  let u: URL;
  try {
    u = new URL(raw ?? "");
  } catch {
    throw new NonRetryableError("Invalid Salesforce instance URL");
  }
  const host = u.hostname.toLowerCase();
  const ok =
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    (u.pathname === "/" || u.pathname === "") &&
    !u.search &&
    !u.hash &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+salesforce\.com$/.test(host) &&
    (host.endsWith(".my.salesforce.com") || host.endsWith(".salesforce.com"));
  if (!ok) throw new NonRetryableError("Invalid Salesforce instance URL");
  return `https://${host}`;
}

export function salesforceLoginHost(environment: string | undefined): string {
  return environment === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";
}

export const salesforceConfigSchema = z.object({
  environment: z.enum(["production", "sandbox"]).optional(),
  ...commonConfigShape,
});
type SalesforceConfig = z.infer<typeof salesforceConfigSchema>;

export interface SalesforceCase {
  Id: string;
  CaseNumber?: string;
  Subject?: string | null;
  Description?: string | null;
  Status?: string | null;
  Priority?: string | null;
  Origin?: string | null;
  Type?: string | null;
  Reason?: string | null;
  CreatedDate?: string;
  LastModifiedDate?: string;
  CaseComments?: { records?: Array<{ CommentBody?: string | null; CreatedDate?: string; IsPublished?: boolean }> } | null;
}

const ID = /^[a-zA-Z0-9]{15,18}$/;

export function mapSalesforceCase(c: SalesforceCase, instanceUrl: string): SyncRecord | null {
  if (!ID.test(c.Id)) return null;
  const header = [
    c.Status ? `Status: ${c.Status}` : null,
    c.Priority ? `Priority: ${c.Priority}` : null,
    c.Origin ? `Origin: ${c.Origin}` : null,
    c.Type ? `Type: ${c.Type}` : null,
    c.Reason ? `Reason: ${c.Reason}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [header, c.Description ? `Customer: ${c.Description.trim()}` : null];
  for (const cm of c.CaseComments?.records ?? []) {
    if (cm.CommentBody?.trim()) lines.push(`${cm.IsPublished ? "Comment" : "Internal comment"}: ${cm.CommentBody.trim()}`);
  }
  const text = lines.filter(Boolean).join("\n\n");
  return {
    externalId: `case:${c.Id}`,
    title: c.Subject?.trim() || titleFrom(c.Description ?? "", `Salesforce case ${c.CaseNumber ?? c.Id}`),
    type: "SUPPORT_TICKET",
    text,
    sourceUrl: `${instanceUrl}/lightning/r/Case/${c.Id}/view`,
    metadata: { provider: "SALESFORCE", caseNumber: c.CaseNumber ?? null, status: c.Status ?? null, createdAt: toIso(c.CreatedDate) },
  };
}

/** SOQL dateTime literal (no quotes, second precision). */
function soqlDateTime(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

const NEXT_RECORDS = /^\/services\/data\/v\d{2,3}\.\d\/query\/[A-Za-z0-9-]{1,200}$/;

export const salesforceConnector: Connector<SalesforceConfig> = {
  provider: "SALESFORCE",
  auth: "oauth",
  configSchema: salesforceConfigSchema,
  authHeaders: (creds) => ({ authorization: `Bearer ${creds.accessToken ?? ""}` }),

  async testConnection(http: ProviderHttp, creds) {
    const base = salesforceInstanceUrl(creds.instanceUrl);
    const info = await http.json<{ organization_id?: string; preferred_username?: string }>(`${base}/services/oauth2/userinfo`);
    return { accountLabel: new URL(base).hostname, account: info.organization_id ? { organizationId: info.organization_id } : undefined };
  },

  async *sync(ctx) {
    let win = readWindow(ctx.cursor, ctx.now, ctx.backfillDays);
    let highWater = win.highWater;
    let records = 0;

    for (let page = 0; page < ctx.limits.maxPages && records < ctx.limits.maxRecords; page++) {
      // Re-read each page: a 401 refresh can change the instance URL.
      const base = salesforceInstanceUrl(ctx.credentials.instanceUrl);
      let url: string;
      if (win.after) {
        if (!NEXT_RECORDS.test(win.after)) throw new NonRetryableError("Invalid Salesforce pagination cursor");
        url = `${base}${win.after}`;
      } else {
        const soql =
          "SELECT Id, CaseNumber, Subject, Description, Status, Priority, Origin, Type, Reason, CreatedDate, LastModifiedDate, " +
          "(SELECT CommentBody, CreatedDate, IsPublished FROM CaseComments ORDER BY CreatedDate ASC LIMIT 20) " +
          `FROM Case WHERE LastModifiedDate >= ${soqlDateTime(win.since!)} ORDER BY LastModifiedDate ASC`;
        url = `${base}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
      }
      const res = await ctx.http.json<{ records?: SalesforceCase[]; done?: boolean; nextRecordsUrl?: string | null }>(url, {
        headers: { "sforce-query-options": "batchSize=200" },
      });
      const batch: SyncRecord[] = [];
      for (const c of res.records ?? []) {
        const rec = mapSalesforceCase(c, base);
        if (!rec) continue;
        highWater = maxIso(highWater, toIso(c.LastModifiedDate));
        batch.push(rec);
      }
      records += batch.length;
      const next = !res.done && res.nextRecordsUrl && NEXT_RECORDS.test(res.nextRecordsUrl) ? res.nextRecordsUrl : null;
      win = advanceWindow(win, next, highWater);
      yield { records: batch, cursor: win, done: !next };
      if (!next) return;
      highWater = win.highWater;
    }
  },
};
