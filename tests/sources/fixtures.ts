/**
 * Minimal, realistic API responses for each of the 12 providers, served by a
 * fake transport (no network). Each fixture lists the credentials it needs,
 * the documents a sync should produce and a phrase that must appear in them.
 */
import type { IntegrationProvider } from "@prisma/client";
import type { Credentials } from "@/server/integrations/credentials";
import { fakeResponse, unexpected, type FakeHandler } from "./helpers";

export const FIXED_NOW = new Date("2026-11-24T12:00:00Z");
const RECENT_ISO = "2026-11-20T10:00:00.000Z";
const RECENT_UNIX = Math.floor(Date.parse(RECENT_ISO) / 1000);

export interface ProviderFixture {
  credentials: Credentials;
  config?: Record<string, unknown>;
  handler: FakeHandler;
  expectedDocs: number;
  expectText: string;
  externalIdPrefix: string;
  type: "SUPPORT_TICKET" | "TRANSCRIPT" | "NOTE" | "OTHER";
}

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}
const compactToIso = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export const FIXTURES: Record<IntegrationProvider, ProviderFixture> = {
  INTERCOM: {
    credentials: { accessToken: "intercom-secret-token" },
    expectedDocs: 1,
    expectText: "export to CSV fails",
    externalIdPrefix: "conversation:",
    type: "SUPPORT_TICKET",
    handler: (c) => {
      if (c.url.pathname === "/conversations/search" && c.method === "POST") {
        return fakeResponse(200, { type: "conversation.list", conversations: [{ id: "101", updated_at: RECENT_UNIX }], total_count: 1, pages: { next: null } });
      }
      if (c.url.pathname === "/conversations/101") {
        return fakeResponse(200, {
          id: "101",
          created_at: RECENT_UNIX - 600,
          updated_at: RECENT_UNIX,
          state: "open",
          source: { subject: "", body: "<p>Hi, export to CSV fails every time.</p>", author: { type: "user", name: "Dana" } },
          tags: { tags: [{ name: "bug" }] },
          conversation_parts: {
            conversation_parts: [
              { part_type: "comment", body: "Thanks Dana, we're looking into it.", author: { type: "admin", name: "Lee" } },
              { part_type: "note", body: "Linked to ENG-42", author: { type: "admin", name: "Lee" } },
            ],
          },
        });
      }
      return unexpected(c);
    },
  },

  ZENDESK: {
    credentials: { accessToken: "zendesk-secret-token", subdomain: "acme" },
    expectedDocs: 1,
    expectText: "SSO login loops",
    externalIdPrefix: "ticket:",
    type: "SUPPORT_TICKET",
    handler: (c) => {
      if (c.url.host !== "acme.zendesk.com") return unexpected(c);
      if (c.url.pathname === "/api/v2/incremental/tickets/cursor.json") {
        return fakeResponse(200, {
          tickets: [
            { id: 55, subject: "SSO login loops", description: "SSO login loops back to the start", status: "open", priority: "high", tags: ["sso"], updated_at: RECENT_ISO },
            { id: 56, subject: "spam", status: "deleted" },
          ],
          after_cursor: "MTU3NjYxMzUzOS4wfHwxMjY1fA==",
          end_of_stream: true,
        });
      }
      if (c.url.pathname === "/api/v2/tickets/55/comments.json") {
        return fakeResponse(200, {
          comments: [
            { author_id: 1, plain_body: "SSO login loops back to the start page.", public: true },
            { author_id: 2, plain_body: "Escalated to engineering.", public: false },
          ],
          users: [
            { id: 1, name: "Riya", role: "end-user" },
            { id: 2, name: "Max", role: "agent" },
          ],
        });
      }
      return unexpected(c);
    },
  },

  GONG: {
    credentials: { accessToken: "gong-secret-token", apiBaseUrl: "https://us-1234.api.gong.io" },
    expectedDocs: 1,
    expectText: "onboarding took three weeks",
    externalIdPrefix: "call:",
    type: "TRANSCRIPT",
    handler: (c) => {
      if (c.url.host !== "us-1234.api.gong.io") return unexpected(c);
      if (c.url.pathname === "/v2/calls/extensive") {
        return fakeResponse(200, {
          records: { totalRecords: 1, currentPageSize: 1 },
          calls: [
            {
              metaData: { id: "7782342274025937895", title: "Acme renewal", started: RECENT_ISO, duration: 1800, url: "https://app.gong.io/call?id=7782342274025937895" },
              parties: [
                { speakerId: "s1", name: "Jo (Acme)", affiliation: "External" },
                { speakerId: "s2", name: "Kim", affiliation: "Internal" },
              ],
            },
          ],
        });
      }
      if (c.url.pathname === "/v2/calls/transcript") {
        return fakeResponse(200, {
          callTranscripts: [
            {
              callId: "7782342274025937895",
              transcript: [
                { speakerId: "s1", sentences: [{ start: 0, end: 4000, text: "Honestly onboarding took three weeks." }] },
                { speakerId: "s2", sentences: [{ start: 4000, end: 6000, text: "That's useful, thank you." }] },
              ],
            },
          ],
        });
      }
      return unexpected(c);
    },
  },

  SLACK: {
    credentials: { botToken: "xoxb-slack-secret-token" },
    expectedDocs: 1,
    expectText: "dark mode please",
    externalIdPrefix: "C0123456789:",
    type: "NOTE",
    handler: (c) => {
      if (c.url.host !== "slack.com") return unexpected(c);
      const method = c.url.pathname.replace("/api/", "");
      switch (method) {
        case "users.conversations":
          return fakeResponse(200, { ok: true, channels: [{ id: "C0123456789", name: "feedback" }] });
        case "conversations.history":
          return fakeResponse(200, {
            ok: true,
            messages: [
              { type: "message", user: "U111", text: "Customer asked: dark mode please <@U222>", ts: `${RECENT_UNIX}.000100`, reply_count: 1, thread_ts: `${RECENT_UNIX}.000100` },
              { type: "message", bot_id: "B1", text: "Deploy finished", ts: `${RECENT_UNIX + 5}.000200` },
              { type: "message", subtype: "channel_join", user: "U333", text: "joined", ts: `${RECENT_UNIX + 6}.000300` },
            ],
            has_more: false,
          });
        case "conversations.replies":
          return fakeResponse(200, {
            ok: true,
            messages: [
              { type: "message", user: "U111", text: "Customer asked: dark mode please", ts: `${RECENT_UNIX}.000100`, thread_ts: `${RECENT_UNIX}.000100` },
              { type: "message", user: "U222", text: "+1 from two more accounts", ts: `${RECENT_UNIX + 60}.000400`, thread_ts: `${RECENT_UNIX}.000100` },
            ],
          });
        case "users.info":
          return fakeResponse(200, { ok: true, user: { real_name: c.url.searchParams.get("user") === "U111" ? "Ana" : "Ben", profile: { display_name: "" } } });
        default:
          return unexpected(c);
      }
    },
  },

  HUBSPOT: {
    credentials: { accessToken: "hubspot-secret-token" },
    config: { account: { portalId: "123456" } },
    expectedDocs: 2,
    expectText: "invoice PDF is blank",
    externalIdPrefix: "ticket:",
    type: "SUPPORT_TICKET",
    handler: (c) => {
      if (c.url.host === "api.hubapi.com" && c.url.pathname === "/crm/v3/objects/tickets/search") {
        return fakeResponse(200, {
          total: 2,
          results: [
            { id: "9001", properties: { subject: "Blank invoice", content: "The invoice PDF is blank", hs_ticket_priority: "HIGH", hs_lastmodifieddate: RECENT_ISO, createdate: RECENT_ISO } },
            { id: "9002", properties: { subject: "Feature request", content: "Please add Xero sync", hs_lastmodifieddate: RECENT_ISO, createdate: RECENT_ISO } },
          ],
        });
      }
      return unexpected(c);
    },
  },

  SALESFORCE: {
    credentials: { accessToken: "sf-secret-token", refreshToken: "sf-refresh", instanceUrl: "https://acme.my.salesforce.com" },
    expectedDocs: 1,
    expectText: "bulk edit times out",
    externalIdPrefix: "case:",
    type: "SUPPORT_TICKET",
    handler: (c) => {
      if (c.url.host !== "acme.my.salesforce.com") return unexpected(c);
      if (c.url.pathname === "/services/data/v62.0/query") {
        return fakeResponse(200, {
          totalSize: 1,
          done: true,
          records: [
            {
              Id: "500Dn00000ABCDE",
              CaseNumber: "00001026",
              Subject: "Bulk edit",
              Description: "The bulk edit times out for 500+ rows",
              Status: "New",
              Priority: "High",
              LastModifiedDate: "2026-11-20T10:00:00.000+0000",
              CaseComments: { records: [{ CommentBody: "Reproduced on staging", IsPublished: false }] },
            },
          ],
        });
      }
      return unexpected(c);
    },
  },

  LINEAR: {
    credentials: { apiKey: "lin_api_linearsecretkey123456" },
    expectedDocs: 1,
    expectText: "Slack alerts for churn risk",
    externalIdPrefix: "issue:",
    type: "NOTE",
    handler: (c) => {
      if (c.url.toString() !== "https://api.linear.app/graphql") return unexpected(c);
      const body = JSON.parse(c.body ?? "{}") as { query: string };
      if (body.query.includes("viewer")) return fakeResponse(200, { data: { viewer: { name: "Pat" }, organization: { name: "Acme" } } });
      return fakeResponse(200, {
        data: {
          issues: {
            nodes: [
              {
                id: "9cfb482a-81e3-4154-b5b9-2c805e70a02d",
                identifier: "ENG-42",
                title: "Slack alerts for churn risk",
                description: "Three customers asked for Slack alerts for churn risk.",
                url: "https://linear.app/acme/issue/ENG-42",
                priorityLabel: "High",
                updatedAt: RECENT_ISO,
                createdAt: RECENT_ISO,
                state: { name: "Backlog" },
                team: { key: "ENG", name: "Engineering" },
                creator: { name: "Pat" },
                labels: { nodes: [{ name: "customer" }] },
                comments: { nodes: [{ body: "Acme too", user: { name: "Sam" } }] },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    },
  },

  JIRA: {
    credentials: { email: "pm@acme.test", apiToken: "jira-secret-token", siteSubdomain: "acme" },
    expectedDocs: 1,
    expectText: "audit log export",
    externalIdPrefix: "issue:",
    type: "NOTE",
    handler: (c) => {
      if (c.url.host !== "acme.atlassian.net") return unexpected(c);
      if (c.url.pathname === "/rest/api/3/myself") return fakeResponse(200, { displayName: "PM", timeZone: "Europe/London" });
      if (c.url.pathname === "/rest/api/3/search/jql" && c.method === "POST") {
        return fakeResponse(200, {
          issues: [
            {
              id: "10001",
              key: "PROD-12",
              fields: {
                summary: "Audit log export",
                description: adf("Enterprise customers need audit log export."),
                status: { name: "To Do" },
                priority: { name: "Medium" },
                issuetype: { name: "Story" },
                labels: ["enterprise"],
                updated: "2026-11-20T10:00:00.000+0000",
                created: "2026-11-19T10:00:00.000+0000",
                reporter: { displayName: "Sam" },
                comment: { comments: [{ author: { displayName: "Lee" }, body: adf("Blocking two deals.") }] },
              },
            },
          ],
          isLast: true,
        });
      }
      return unexpected(c);
    },
  },

  NOTION: {
    credentials: { apiKey: "ntn_notionsecretkey1234567890" }, // gitleaks:allow fake test credential
    expectedDocs: 1,
    expectText: "They need SSO",
    externalIdPrefix: "page:",
    type: "NOTE",
    handler: (c) => {
      if (c.url.host !== "api.notion.com") return unexpected(c);
      if (c.url.pathname === "/v1/search") {
        return fakeResponse(200, {
          object: "list",
          results: [
            {
              object: "page",
              id: "5c6a2821-6bb1-4a7e-b6e1-c50111515c3d",
              url: "https://www.notion.so/Interview-with-Acme-5c6a28216bb14a7eb6e1c50111515c3d",
              created_time: RECENT_ISO,
              last_edited_time: RECENT_ISO,
              properties: { Name: { type: "title", title: [{ plain_text: "Interview with Acme" }] } },
            },
            {
              object: "page",
              id: "6d7b3932-7cc2-4b8f-c7f2-d61222626d4e",
              last_edited_time: "2026-11-19T10:00:00.000Z",
              archived: true,
              properties: { Name: { type: "title", title: [{ plain_text: "Old draft" }] } },
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      if (c.url.pathname.startsWith("/v1/blocks/5c6a2821-6bb1-4a7e-b6e1-c50111515c3d/children")) {
        return fakeResponse(200, {
          results: [
            { id: "b1", type: "heading_2", heading_2: { rich_text: [{ plain_text: "Needs" }] }, has_children: false },
            { id: "b2", type: "paragraph", paragraph: { rich_text: [{ plain_text: "They need SSO before rollout." }] }, has_children: false },
            { id: "b3", type: "toggle", toggle: { rich_text: [{ plain_text: "Details" }] }, has_children: true },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      if (c.url.pathname.startsWith("/v1/blocks/b3/children")) {
        return fakeResponse(200, {
          results: [{ id: "b4", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Okta first" }] }, has_children: false }],
          has_more: false,
          next_cursor: null,
        });
      }
      return unexpected(c);
    },
  },

  PRODUCTBOARD: {
    credentials: { apiToken: "pb-secret-token-abcdefghijklmnop" },
    expectedDocs: 1,
    expectText: "wants Slack alerts",
    externalIdPrefix: "note:",
    type: "NOTE",
    handler: (c) => {
      if (c.url.host === "api.productboard.com" && c.url.pathname === "/notes") {
        return fakeResponse(200, {
          data: [
            {
              id: "a1b2c3",
              title: "Slack alerts",
              content: "<p>Customer <b>wants Slack alerts</b> for SLA breaches</p>",
              displayUrl: "https://acme.productboard.com/inbox/notes/a1b2c3",
              tags: ["alerts"],
              updatedAt: RECENT_ISO,
              createdAt: RECENT_ISO,
              company: { name: "Acme" },
              user: { name: "Dana" },
            },
          ],
          pageCursor: null,
        });
      }
      return unexpected(c);
    },
  },

  AMPLITUDE: {
    credentials: { apiKey: "0123456789abcdef0123456789abcdef", secretKey: "fedcba9876543210fedcba9876543210" }, // gitleaks:allow fake test credentials
    expectedDocs: 14,
    expectText: "Export Clicked",
    externalIdPrefix: "daily:",
    type: "OTHER",
    handler: (c) => {
      if (c.url.host !== "amplitude.com") return unexpected(c);
      if (c.url.pathname === "/api/2/events/list") {
        return fakeResponse(200, { data: [{ value: "Export Clicked", totals: 500 }, { value: "Signup", totals: 100 }, { value: "Hidden", totals: 999, hidden: true }] });
      }
      if (c.url.pathname === "/api/2/events/segmentation") {
        const xs = days(compactToIso(c.url.searchParams.get("start")!), compactToIso(c.url.searchParams.get("end")!));
        const uniques = c.url.searchParams.get("m") === "uniques";
        return fakeResponse(200, { data: { series: [xs.map((_, i) => (uniques ? 5 : 10) + i)], xValues: xs, seriesLabels: [0] } });
      }
      return unexpected(c);
    },
  },

  MIXPANEL: {
    credentials: { serviceAccountUsername: "beacon.sa.123", serviceAccountSecret: "mixpanel-secret-value", projectId: "1234567" },
    expectedDocs: 14,
    expectText: "Report Viewed",
    externalIdPrefix: "daily:",
    type: "OTHER",
    handler: (c) => {
      if (c.url.host !== "mixpanel.com") return unexpected(c);
      if (c.url.pathname === "/api/query/events/names") return fakeResponse(200, ["Report Viewed", "Signup"]);
      if (c.url.pathname === "/api/query/events") {
        const xs = days(c.url.searchParams.get("from_date")!, c.url.searchParams.get("to_date")!);
        const unique = c.url.searchParams.get("type") === "unique";
        const values = Object.fromEntries(["Report Viewed", "Signup"].map((e) => [e, Object.fromEntries(xs.map((d, i) => [d, (unique ? 3 : 7) + i]))]));
        return fakeResponse(200, { data: { series: xs, values }, legend_size: 2 });
      }
      return unexpected(c);
    },
  },
};
