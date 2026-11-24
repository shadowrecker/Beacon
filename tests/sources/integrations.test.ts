import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/db";
import { safeFetch } from "@/lib/safe-fetch";
import { QUEUE } from "@/server/jobs/queues";
import { NonRetryableError } from "@/server/jobs/worker";
import { decryptCredentials } from "@/server/integrations/credentials";
import { createProviderHttp, ProviderError, setIntegrationSleepForTests, setIntegrationTransportForTests } from "@/server/integrations/http";
import { PROVIDERS } from "@/server/integrations/index";
import { flowCookieName, signState, verifyState } from "@/server/integrations/oauth";
import { beginOAuth, completeOAuth } from "@/server/integrations/oauth-flow";
import { salesforceInstanceUrl } from "@/server/integrations/salesforce";
import { gongBaseUrl } from "@/server/integrations/gong";
import { zendeskBaseUrl, zendeskSubdomain } from "@/server/integrations/zendesk";
import { runIntegrationSync } from "@/server/integrations/sync";
import { run as scheduleIntegrations } from "@/server/schedules/integrations";
import { resetMarketplaceSeedForTests } from "@/server/marketplace/registry";
import { integrationWorker } from "@/workers/integration-worker";
import { jobsFor } from "../helpers/doubles";
import { addMember, createOrg, createProject, createUser, type TestUser } from "../helpers/factories";
import { FIXED_NOW, FIXTURES } from "./fixtures";
import { callerFor, createConnectedIntegration, fakeResponse, installTransport, log, newSync, runWorker, unexpected } from "./helpers";

process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
process.env.SLACK_CLIENT_ID = "slack-client-id";
process.env.SLACK_CLIENT_SECRET = "slack-client-secret";
process.env.ZENDESK_CLIENT_ID = "zendesk-client-id";
process.env.ZENDESK_CLIENT_SECRET = "zendesk-client-secret";
process.env.SALESFORCE_CLIENT_ID = "sf-client-id";
process.env.SALESFORCE_CLIENT_SECRET = "sf-client-secret";
delete process.env.GONG_CLIENT_ID;
delete process.env.GONG_CLIENT_SECRET;

beforeEach(() => {
  resetMarketplaceSeedForTests();
  setIntegrationSleepForTests(async () => undefined);
});
afterEach(() => {
  setIntegrationTransportForTests(null);
  setIntegrationSleepForTests(null);
});

async function workspace() {
  const owner = await createUser();
  const org = await createOrg(owner);
  const project = await createProject(owner, org.id);
  return { owner, org, project };
}

function cookieJar(cookie: { name: string; value: string }) {
  return (name: string) => (name === cookie.name ? cookie.value : undefined);
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

describe("OAuth state and callback", () => {
  async function startSlack(user: TestUser, projectId: string) {
    return beginOAuth({ userId: user.id, params: new URLSearchParams({ provider: "SLACK", projectId }) });
  }

  it("signs state, sets a user-bound cookie, and redirects to the provider", async () => {
    const { owner, project } = await workspace();
    const res = await startSlack(owner, project.id);
    const url = new URL(res.redirectUrl);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("slack-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/integrations/oauth/callback");
    const state = verifyState(url.searchParams.get("state"));
    expect(state).toMatchObject({ userId: owner.id, projectId: project.id, provider: "SLACK" });
    expect(res.cookie.name).toBe(flowCookieName("SLACK"));
    expect(res.cookie.value).not.toContain(state.nonce); // the cookie body is encoded and HMAC-bound
  });

  it("uses PKCE for providers that support it and validates the Zendesk subdomain", async () => {
    const { owner, project } = await workspace();
    const res = await beginOAuth({ userId: owner.id, params: new URLSearchParams({ provider: "ZENDESK", projectId: project.id, subdomain: "acme" }) });
    const url = new URL(res.redirectUrl);
    expect(url.host).toBe("acme.zendesk.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    for (const subdomain of ["evil.com#", "evil.com/x?", "acme.evil", "", "-acme", "a b"]) {
      await expect(
        beginOAuth({ userId: owner.id, params: new URLSearchParams({ provider: "ZENDESK", projectId: project.id, subdomain }) })
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  it("refuses to start for members without integrations:manage, outsiders and unconfigured providers", async () => {
    const { org, project } = await workspace();
    const member = await createUser();
    await addMember(org.id, member, "MEMBER");
    const outsider = await createUser();
    await expect(startSlack(member, project.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(startSlack(outsider, project.id)).rejects.toMatchObject({ code: "forbidden" });
    const { owner, project: p2 } = await workspace();
    await expect(beginOAuth({ userId: owner.id, params: new URLSearchParams({ provider: "GONG", projectId: p2.id }) })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("completes the flow: exchanges the code server-side and stores encrypted tokens", async () => {
    const { owner, org, project } = await workspace();
    const start = await startSlack(owner, project.id);
    const state = new URL(start.redirectUrl).searchParams.get("state")!;
    const calls = installTransport((c) => {
      if (c.url.toString() === "https://slack.com/api/oauth.v2.access") {
        expect(c.body).toContain("code=the-code");
        expect(c.body).toContain("client_secret=slack-client-secret");
        return fakeResponse(200, { ok: true, access_token: "xoxb-very-secret", token_type: "bot", team: { id: "T1", name: "Acme" } });
      }
      if (c.url.toString() === "https://slack.com/api/auth.test") return fakeResponse(200, { ok: true, team: "Acme", team_id: "T1" });
      return unexpected(c);
    });

    const res = await completeOAuth({ userId: owner.id, params: new URLSearchParams({ code: "the-code", state }), readCookie: cookieJar(start.cookie) });
    expect(res.redirectPath).toBe("/integrations?connected=SLACK");
    expect(res.clearCookie).toBe(flowCookieName("SLACK"));
    expect(calls).toHaveLength(2);

    const row = await prisma.integration.findUniqueOrThrow({ where: { orgId_provider: { orgId: org.id, provider: "SLACK" } } });
    expect(row.status).toBe("CONNECTED");
    expect(row.projectId).toBe(project.id);
    expect(JSON.stringify(row)).not.toContain("xoxb-very-secret");
    expect(decryptCredentials(row.credentialsEncrypted)).toEqual({ botToken: "xoxb-very-secret" });
    const sync = await prisma.integrationSync.findFirstOrThrow({ where: { integrationId: row.id } });
    expect(sync.status).toBe("PENDING");
    expect(jobsFor(QUEUE.INTEGRATION_SYNC).map((j) => j.payload)).toContainEqual({ integrationId: row.id, syncId: sync.id });
  });

  it("rejects forged, expired, cross-user and cookie-less callbacks without calling the provider", async () => {
    const { owner, project } = await workspace();
    const other = await createUser();
    const start = await startSlack(owner, project.id);
    const state = new URL(start.redirectUrl).searchParams.get("state")!;
    const calls = installTransport((c) => unexpected(c));
    const call = (params: Record<string, string>, userId: string | null = owner.id, cookies = cookieJar(start.cookie)) =>
      completeOAuth({ userId, params: new URLSearchParams(params), readCookie: cookies });

    // Forged: payload altered (another project) with the original signature.
    const [body, sig] = [state.slice(0, state.lastIndexOf(".")), state.slice(state.lastIndexOf(".") + 1)];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const tampered = `${Buffer.from(JSON.stringify({ ...payload, orgId: "c".repeat(25) })).toString("base64url")}.${sig}`;
    expect((await call({ code: "x", state: tampered })).redirectPath).toContain("oauth_error=invalid_state");
    // Signed with the wrong key.
    expect((await call({ code: "x", state: `${body}.${"0".repeat(64)}` })).redirectPath).toContain("oauth_error=invalid_state");
    // Expired.
    const expired = signState({ ...payload, exp: Date.now() - 1000 });
    expect((await call({ code: "x", state: expired })).redirectPath).toContain("oauth_error=expired");
    // Another signed-in user (or nobody).
    expect((await call({ code: "x", state }, other.id)).redirectPath).toContain("oauth_error=session_mismatch");
    expect((await call({ code: "x", state }, null)).redirectPath).toContain("oauth_error=session_mismatch");
    // Missing cookie (flow started in another browser).
    expect((await call({ code: "x", state }, owner.id, () => undefined)).redirectPath).toContain("oauth_error=cookie_missing");
    // Cookie from a different flow (nonce mismatch).
    const second = await startSlack(owner, project.id);
    expect((await call({ code: "x", state }, owner.id, cookieJar(second.cookie))).redirectPath).toContain("oauth_error=invalid_state");
    // Provider-side denial.
    expect((await call({ error: "access_denied", state })).redirectPath).toContain("oauth_error=access_denied");

    expect(calls).toHaveLength(0);
    expect(await prisma.integration.count()).toBe(0);
  });

  it("re-checks authorization at the callback (a demoted admin can't finish the flow)", async () => {
    const { org, project } = await workspace();
    const admin = await createUser();
    await addMember(org.id, admin, "ADMIN");
    const start = await startSlack(admin, project.id);
    await prisma.orgMember.update({ where: { orgId_userId: { orgId: org.id, userId: admin.id } }, data: { role: "MEMBER" } });
    installTransport((c) => unexpected(c));
    const state = new URL(start.redirectUrl).searchParams.get("state")!;
    const res = await completeOAuth({ userId: admin.id, params: new URLSearchParams({ code: "x", state }), readCookie: cookieJar(start.cookie) });
    expect(res.redirectPath).toContain("oauth_error=forbidden");
  });
});

// ---------------------------------------------------------------------------
// Host validation
// ---------------------------------------------------------------------------

describe("provider host validation", () => {
  it("accepts only bare Zendesk subdomains", () => {
    expect(zendeskBaseUrl("acme")).toBe("https://acme.zendesk.com");
    expect(zendeskSubdomain("Acme-Support")).toBe("acme-support");
    for (const bad of ["evil.com/x?", "acme.evil.com", "acme@evil.com", "acme:443", "acme#", "../acme", "", "a".repeat(64)]) {
      expect(() => zendeskBaseUrl(bad)).toThrow(NonRetryableError);
    }
  });

  it("accepts only https *.salesforce.com instance URLs without path, port or credentials", () => {
    expect(salesforceInstanceUrl("https://acme.my.salesforce.com")).toBe("https://acme.my.salesforce.com");
    expect(salesforceInstanceUrl("https://acme--uat.sandbox.my.salesforce.com/")).toBe("https://acme--uat.sandbox.my.salesforce.com");
    expect(salesforceInstanceUrl("https://na1.salesforce.com")).toBe("https://na1.salesforce.com");
    for (const bad of [
      "https://evil.com",
      "https://acme.my.salesforce.com.evil.com",
      "https://salesforce.com.evil.com",
      "http://acme.my.salesforce.com",
      "https://user:pw@acme.my.salesforce.com",
      "https://acme.my.salesforce.com:8443",
      "https://acme.my.salesforce.com/services/data",
      "https://acme.my.salesforce.com?x=1",
      "javascript:alert(1)",
      "https://evilsalesforce.com",
    ]) {
      expect(() => salesforceInstanceUrl(bad)).toThrow(NonRetryableError);
    }
  });

  it("validates the Gong customer API host", () => {
    expect(gongBaseUrl("https://us-1234.api.gong.io")).toBe("https://us-1234.api.gong.io");
    for (const bad of ["https://api.gong.io.evil.com", "http://api.gong.io", "https://evil.com", "https://api.gong.io:444"]) {
      expect(() => gongBaseUrl(bad)).toThrow(NonRetryableError);
    }
  });

  it("can't reach a local test server through safeFetch (private addresses are blocked)", async () => {
    await expect(safeFetch("https://127.0.0.1:9/")).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    await expect(safeFetch("https://localhost/")).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
    await expect(safeFetch("https://169.254.169.254/latest/meta-data")).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
  });
});

// ---------------------------------------------------------------------------
// Connectors (fixtures for every provider)
// ---------------------------------------------------------------------------

describe("connector sync with recorded fixtures", () => {
  for (const provider of PROVIDERS) {
    it(`${provider}: ingests records as documents in the target project, idempotently`, async () => {
      const { owner, org, project } = await workspace();
      const fx = FIXTURES[provider];
      const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider, credentials: fx.credentials, config: fx.config });
      installTransport(fx.handler);

      const sync = await newSync(integ.id);
      const out = await runIntegrationSync({ integrationId: integ.id, syncId: sync.id }, { log, now: FIXED_NOW });
      expect(out.status).toBe("completed");

      const docs = await prisma.document.findMany({ where: { integrationId: integ.id }, orderBy: { externalId: "asc" } });
      expect(docs).toHaveLength(fx.expectedDocs);
      for (const d of docs) {
        expect(d.projectId).toBe(project.id);
        expect(d.source).toBe("INTEGRATION");
        expect(d.type).toBe(fx.type);
        expect(d.externalId?.startsWith(fx.externalIdPrefix)).toBe(true);
        if (d.sourceUrl) expect(d.sourceUrl).toMatch(/^https:\/\//);
      }
      expect(docs.map((d) => d.processedText).join("\n")).toContain(fx.expectText);

      const after = await prisma.integrationSync.findUniqueOrThrow({ where: { id: sync.id } });
      expect(after).toMatchObject({ status: "COMPLETED", recordsProcessed: fx.expectedDocs });
      const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
      expect(row.lastSyncAt).not.toBeNull();
      expect(row.syncCursor).toMatchObject({ v: 1 });

      // Re-sync from scratch (cursor reset): records are upserted, never duplicated.
      await prisma.integration.update({ where: { id: integ.id }, data: { syncCursor: Prisma.DbNull } });
      const again = await newSync(integ.id);
      await runIntegrationSync({ integrationId: integ.id, syncId: again.id }, { log, now: FIXED_NOW });
      expect(await prisma.document.count({ where: { integrationId: integ.id } })).toBe(fx.expectedDocs);
      expect(await prisma.document.count({ where: { projectId: project.id } })).toBe(fx.expectedDocs);
    });
  }

  it("strips bots, joins and internal-only data correctly (Slack threads, Zendesk notes)", async () => {
    const { owner, org, project } = await workspace();
    for (const provider of ["SLACK", "ZENDESK"] as IntegrationProvider[]) {
      const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider, credentials: FIXTURES[provider].credentials });
      installTransport(FIXTURES[provider].handler);
      const s = await newSync(integ.id);
      await runIntegrationSync({ integrationId: integ.id, syncId: s.id }, { log, now: FIXED_NOW });
    }
    const slack = await prisma.document.findFirstOrThrow({ where: { integration: { provider: "SLACK" } } });
    expect(slack.processedText).toContain("Ana: Customer asked: dark mode please @Ben");
    expect(slack.processedText).toContain("↳ Ben: +1 from two more accounts");
    expect(slack.processedText).not.toContain("Deploy finished");
    const zendesk = await prisma.document.findFirstOrThrow({ where: { integration: { provider: "ZENDESK" } } });
    expect(zendesk.processedText).toContain("Customer (Riya): SSO login loops");
    expect(zendesk.processedText).toContain("Agent (Max) [internal note]: Escalated");
  });

  it("continues capped syncs from the stored cursor and reports hasMore", async () => {
    const { owner, org, project } = await workspace();
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "HUBSPOT", credentials: { accessToken: "t" } });
    const afters: Array<string | undefined> = [];
    installTransport((c) => {
      const body = JSON.parse(c.body ?? "{}") as { after?: string };
      afters.push(body.after);
      const page = Number(body.after ?? "0");
      return fakeResponse(200, {
        results: [{ id: String(100 + page), properties: { subject: `T${page}`, content: `ticket ${page}`, hs_lastmodifieddate: new Date(Date.parse("2026-11-20T00:00:00Z") + page * 1000).toISOString() } }],
        paging: page < 4 ? { next: { after: String(page + 1) } } : undefined,
      });
    });
    const s1 = await newSync(integ.id);
    const r1 = await runIntegrationSync({ integrationId: integ.id, syncId: s1.id }, { log, now: FIXED_NOW, limits: { maxPages: 2, maxRecords: 100 } });
    expect(r1.hasMore).toBe(true);
    expect(afters).toEqual([undefined, "1"]);
    const s2 = await newSync(integ.id);
    const r2 = await runIntegrationSync({ integrationId: integ.id, syncId: s2.id }, { log, now: FIXED_NOW, limits: { maxPages: 10, maxRecords: 100 } });
    expect(r2.hasMore).toBe(false);
    expect(afters).toEqual([undefined, "1", "2", "3", "4"]);
    expect(await prisma.document.count({ where: { integrationId: integ.id } })).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// HTTP behaviour: 429 / retry-after, auth failures
// ---------------------------------------------------------------------------

describe("provider HTTP handling", () => {
  it("honors a short Retry-After inline and throws a retryable 429 for a long one", async () => {
    let n = 0;
    const waits: number[] = [];
    setIntegrationSleepForTests(async (ms) => {
      waits.push(ms);
    });
    installTransport(() => (n++ === 0 ? fakeResponse(429, { error: "rate" }, { "retry-after": "2" }) : fakeResponse(200, { ok: true })));
    const http = createProviderHttp({ provider: "Test" });
    await expect(http.json("https://api.example.com/x")).resolves.toEqual({ ok: true });
    expect(waits).toEqual([2000]);

    installTransport(() => fakeResponse(429, {}, { "retry-after": "120" }));
    const err = await http.json("https://api.example.com/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 120_000 });
  });

  it("a 429 during a sync is retried by the job framework (row stays non-terminal)", async () => {
    const { owner, org, project } = await workspace();
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "PRODUCTBOARD", credentials: FIXTURES.PRODUCTBOARD.credentials });
    installTransport(() => fakeResponse(429, {}, { "retry-after": "300" }));
    const sync = await newSync(integ.id);
    await expect(runWorker(integrationWorker, { integrationId: integ.id, syncId: sync.id }, 1, 3)).rejects.toMatchObject({ status: 429 });
    expect((await prisma.integrationSync.findUniqueOrThrow({ where: { id: sync.id } })).status).toBe("RUNNING");

    // The retry succeeds and completes the same row.
    installTransport(FIXTURES.PRODUCTBOARD.handler);
    await runWorker(integrationWorker, { integrationId: integ.id, syncId: sync.id }, 2, 3);
    expect(await prisma.integrationSync.findUniqueOrThrow({ where: { id: sync.id } })).toMatchObject({ status: "COMPLETED", recordsProcessed: 1 });
    expect(await prisma.integrationSync.count({ where: { integrationId: integ.id } })).toBe(1);
  });

  it("refreshes an expired OAuth token, then fails with a reconnect error if the provider still rejects it", async () => {
    const { owner, org, project } = await workspace();
    const integ = await createConnectedIntegration({
      orgId: org.id,
      userId: owner.id,
      projectId: project.id,
      provider: "SALESFORCE",
      credentials: { accessToken: "old", refreshToken: "refresh-1", instanceUrl: "https://acme.my.salesforce.com" },
    });
    let refreshed = 0;
    installTransport((c) => {
      if (c.url.toString() === "https://login.salesforce.com/services/oauth2/token") {
        refreshed++;
        expect(c.body).toContain("grant_type=refresh_token");
        return fakeResponse(200, { access_token: "new-token", instance_url: "https://acme.my.salesforce.com" });
      }
      if (c.headers.authorization === "Bearer old") return fakeResponse(401, [{ errorCode: "INVALID_SESSION_ID" }]);
      return FIXTURES.SALESFORCE.handler(c);
    });
    const sync = await newSync(integ.id);
    await runWorker(integrationWorker, { integrationId: integ.id, syncId: sync.id });
    expect(refreshed).toBe(1);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(decryptCredentials(row.credentialsEncrypted)?.accessToken).toBe("new-token");
    expect((await prisma.integrationSync.findUniqueOrThrow({ where: { id: sync.id } })).status).toBe("COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// Worker: producer row, events, notifications
// ---------------------------------------------------------------------------

describe("integration worker", () => {
  it("updates the producer's sync row, sets lastSyncAt to the start time and emits integration.synced", async () => {
    const { owner, org, project } = await workspace();
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "LINEAR", credentials: FIXTURES.LINEAR.credentials });
    installTransport(FIXTURES.LINEAR.handler);
    const sync = await newSync(integ.id);
    const before = new Date();
    await runWorker(integrationWorker, { integrationId: integ.id, syncId: sync.id });
    const done = await prisma.integrationSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(done.status).toBe("COMPLETED");
    expect(done.completedAt).not.toBeNull();
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row.lastSyncAt!.getTime()).toBe(done.startedAt.getTime());
    expect(row.lastSyncAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(await prisma.integrationSync.count({ where: { integrationId: integ.id } })).toBe(1);
    const events = await prisma.domainEvent.findMany({ where: { type: "integration.synced" } });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ integrationId: integ.id, provider: "LINEAR", records: 1 });

    // Re-running a completed sync is a no-op.
    await runWorker(integrationWorker, { integrationId: integ.id, syncId: sync.id });
    expect(await prisma.domainEvent.count({ where: { type: "integration.synced" } })).toBe(1);
  });

  it("marks the row FAILED, flags the integration, emits integration.failed and notifies admins on auth failure", async () => {
    const { owner, org, project } = await workspace();
    const member = await createUser();
    await addMember(org.id, member, "MEMBER");
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "NOTION", credentials: FIXTURES.NOTION.credentials });
    installTransport(() => fakeResponse(401, { object: "error", code: "unauthorized" }));
    const sync = await newSync(integ.id);
    await expect(runWorker(integrationWorker, { integrationId: integ.id, syncId: sync.id })).rejects.toThrow();
    const failed = await prisma.integrationSync.findUniqueOrThrow({ where: { id: sync.id } });
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toMatch(/Reconnect the integration/);
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row.status).toBe("ERROR");
    expect(row.lastError).toMatch(/Reconnect/);
    expect(await prisma.domainEvent.count({ where: { type: "integration.failed" } })).toBe(1);
    const notes = await prisma.notification.findMany({ where: { type: "INTEGRATION_SYNC" } });
    expect(notes.map((n) => n.userId)).toEqual([owner.id]);
  });

  it("fails without a target project", async () => {
    const { owner, org } = await workspace();
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: null, provider: "LINEAR", credentials: FIXTURES.LINEAR.credentials });
    const sync = await newSync(integ.id);
    await expect(runWorker(integrationWorker, { integrationId: integ.id, syncId: sync.id })).rejects.toThrow();
    expect(await prisma.integrationSync.findUniqueOrThrow({ where: { id: sync.id } })).toMatchObject({ status: "FAILED", errorMessage: expect.stringMatching(/target project/) });
  });
});

describe("scheduled sync", () => {
  it("enqueues due integrations once per interval slot", async () => {
    const { owner, org, project } = await workspace();
    const due = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "LINEAR", credentials: FIXTURES.LINEAR.credentials });
    const fresh = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "JIRA", credentials: FIXTURES.JIRA.credentials });
    await prisma.integration.update({ where: { id: fresh.id }, data: { lastSyncAt: new Date() } });
    const noProject = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: null, provider: "NOTION", credentials: FIXTURES.NOTION.credentials });
    const disconnected = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "MIXPANEL", credentials: FIXTURES.MIXPANEL.credentials });
    await prisma.integration.update({ where: { id: disconnected.id }, data: { status: "DISCONNECTED" } });

    expect(await scheduleIntegrations()).toBe(1);
    expect(await scheduleIntegrations()).toBe(0); // PENDING sync exists: not enqueued again
    const jobs = jobsFor(QUEUE.INTEGRATION_SYNC);
    expect(jobs).toHaveLength(1);
    expect((jobs[0].payload as { integrationId: string }).integrationId).toBe(due.id);
    expect(await prisma.integrationSync.count({ where: { integrationId: { in: [fresh.id, noProject.id, disconnected.id] } } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Router: credentials, authz
// ---------------------------------------------------------------------------

describe("integration router", () => {
  it("connects an API-token provider after a live check, stores it encrypted and never returns it", async () => {
    const { owner, org, project } = await workspace();
    installTransport(FIXTURES.LINEAR.handler);
    const caller = callerFor(owner, org.id);
    const res = await caller.integration.connect({ provider: "LINEAR", projectId: project.id, credentials: { apiKey: "lin_api_linearsecretkey123456" } });
    expect(res.accountLabel).toBe("Acme");

    const row = await prisma.integration.findUniqueOrThrow({ where: { id: res.id } });
    expect(row.credentialsEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain("linearsecretkey");
    expect(decryptCredentials(row.credentialsEncrypted)).toEqual({ apiKey: "lin_api_linearsecretkey123456" });
    expect(jobsFor(QUEUE.INTEGRATION_SYNC)).toHaveLength(1);

    const list = await caller.integration.list();
    expect(JSON.stringify(list)).not.toContain("linearsecretkey123");
    expect(list[0].credentials.apiKey).toBe("••••3456");
    expect(list[0]).toMatchObject({ provider: "LINEAR", status: "CONNECTED", project: { id: project.id } });
  });

  it("rejects credentials the provider refuses and invalid credential shapes", async () => {
    const { owner, org, project } = await workspace();
    installTransport(() => fakeResponse(200, { errors: [{ message: "auth", extensions: { code: "AUTHENTICATION_ERROR" } }] }));
    const caller = callerFor(owner, org.id);
    await expect(caller.integration.connect({ provider: "LINEAR", projectId: project.id, credentials: { apiKey: "lin_api_wrongkey1234567890" } })).rejects.toMatchObject({ code: "BAD_REQUEST" }); // gitleaks:allow fake test credential
    await expect(
      caller.integration.connect({ provider: "JIRA", projectId: project.id, credentials: { email: "a@b.co", apiToken: "tokentoken", siteSubdomain: "evil.com/x" } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.integration.count()).toBe(0);
  });

  it("lists providers with configured / not configured state", async () => {
    const { owner } = await workspace();
    const providers = await callerFor(owner).integration.providers();
    expect(providers).toHaveLength(12);
    expect(providers.find((p) => p.provider === "SLACK")?.configured).toBe(true);
    expect(providers.find((p) => p.provider === "GONG")?.configured).toBe(false);
    expect(providers.find((p) => p.provider === "LINEAR")).toMatchObject({ auth: "apiKey", configured: true });
  });

  it("scopes everything to the org: outsiders get NOT_FOUND, members and viewers can't write", async () => {
    const { owner, org, project } = await workspace();
    const viewer = await createUser();
    const member = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    await addMember(org.id, member, "MEMBER");
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "LINEAR", credentials: FIXTURES.LINEAR.credentials });
    const outsider = await createUser();
    const outsiderProject = await createProject(outsider);

    // Outsider acting in their own org can't see or touch this integration.
    const out = callerFor(outsider);
    await expect(out.integration.sync({ id: integ.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.integration.syncHistory({ integrationId: integ.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(out.integration.disconnect({ id: integ.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await out.integration.list()).toHaveLength(0);
    // ...nor act inside the victim org.
    await expect(callerFor(outsider, org.id).integration.list()).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Viewers can read but not write; members can't manage integrations.
    expect(await callerFor(viewer, org.id).integration.list()).toHaveLength(1);
    for (const u of [viewer, member]) {
      const c = callerFor(u, org.id);
      await expect(c.integration.sync({ id: integ.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.integration.disconnect({ id: integ.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.integration.updateConfig({ id: integ.id, config: { teamKeys: ["ENG"] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.integration.connect({ provider: "NOTION", projectId: project.id, credentials: { apiKey: "ntn_notionsecretkey1234567890" } })).rejects.toMatchObject({ code: "FORBIDDEN" }); // gitleaks:allow fake test credential
    }

    // A foreign project can't be made the target.
    await expect(callerFor(owner, org.id).integration.setTargetProject({ id: integ.id, projectId: outsiderProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("sync creates one PENDING row (deduped) and syncHistory paginates", async () => {
    const { owner, org, project } = await workspace();
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "LINEAR", credentials: FIXTURES.LINEAR.credentials });
    const caller = callerFor(owner, org.id);
    const a = await caller.integration.sync({ id: integ.id });
    const b = await caller.integration.sync({ id: integ.id });
    expect(b).toEqual({ syncId: a.syncId, alreadyRunning: true });
    expect(jobsFor(QUEUE.INTEGRATION_SYNC)).toHaveLength(1);
    const history = await caller.integration.syncHistory({ integrationId: integ.id, limit: 10 });
    expect(history.items.map((s) => s.id)).toEqual([a.syncId]);
    expect(history.nextCursor).toBeNull();
  });

  it("updates settings with schema validation and keeps server-derived account details", async () => {
    const { owner, org, project } = await workspace();
    const integ = await createConnectedIntegration({
      orgId: org.id,
      userId: owner.id,
      projectId: project.id,
      provider: "SLACK",
      credentials: FIXTURES.SLACK.credentials,
      config: { account: { teamId: "T1" }, accountLabel: "Acme" },
    });
    const caller = callerFor(owner, org.id);
    const res = await caller.integration.updateConfig({ id: integ.id, config: { channelIds: ["C0123456789"], syncIntervalMinutes: 720, account: { teamId: "EVIL" } } });
    expect(res.config).toMatchObject({ channelIds: ["C0123456789"], syncIntervalMinutes: 720, accountLabel: "Acme" });
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row.config).toMatchObject({ account: { teamId: "T1" } });
    await expect(caller.integration.updateConfig({ id: integ.id, config: { channelIds: ["not a channel"] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await caller.integration.updateConfig({ id: integ.id, config: { defaultChannel: "#product" } });
    const cleared = await caller.integration.updateConfig({ id: integ.id, config: { defaultChannel: "" } });
    expect(cleared.config).not.toHaveProperty("defaultChannel");
  });

  it("disconnect revokes the provider token and deletes the stored credentials", async () => {
    const { owner, org, project } = await workspace();
    const integ = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "SLACK", credentials: { botToken: "xoxb-to-revoke" } });
    const calls = installTransport((c) => {
      if (c.url.toString() === "https://slack.com/api/auth.revoke") return fakeResponse(200, { ok: true, revoked: true });
      return unexpected(c);
    });
    const res = await callerFor(owner, org.id).integration.disconnect({ id: integ.id });
    expect(res.revoked).toBe(true);
    expect(calls[0].headers.authorization).toBe("Bearer xoxb-to-revoke");
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row).toMatchObject({ status: "DISCONNECTED", credentialsEncrypted: null, credentialsKeyVersion: null });

    // API-token providers can't be revoked remotely: the user is told how.
    const lin = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "LINEAR", credentials: FIXTURES.LINEAR.credentials });
    const r2 = await callerFor(owner, org.id).integration.disconnect({ id: lin.id });
    expect(r2.revoked).toBe(false);
    expect(r2.revokeHelp).toMatch(/Linear/);
  });
});
