/**
 * OAuth 2.0 for the six OAuth connectors (Slack, HubSpot, Intercom, Gong,
 * Salesforce, Zendesk).
 *
 * - App credentials come from `<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`. A
 *   provider without them is reported as "not configured"; nothing crashes.
 * - `state` is an HMAC-signed, expiring payload {orgId, userId, projectId,
 *   provider, nonce, exp, extra}. The nonce (and the PKCE verifier) live in an
 *   httpOnly, SameSite=Lax cookie that is itself HMAC-bound to the user, so a
 *   state minted for one browser session can't be completed in another (link
 *   CSRF).
 * - PKCE (S256) where the provider supports it (Salesforce, Zendesk).
 * - Code exchange, refresh and revocation happen server-side only, through the
 *   integration HTTP layer (safeFetch); tokens are encrypted before storage.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { hmacSha256Hex, timingSafeEqualStr } from "@/lib/crypto";
import type { Credentials } from "./credentials";
import { basicAuth, createProviderHttp, ProviderAuthError, ProviderError, type ProviderHttp } from "./http";
import { gongBaseUrl } from "./gong";
import { salesforceInstanceUrl, salesforceLoginHost } from "./salesforce";
import { zendeskBaseUrl, zendeskSubdomain } from "./zendesk";
import { isOAuthProvider, type OAuthProvider } from "./index";

export const STATE_TTL_MS = 10 * 60_000;

export class OAuthFlowError extends Error {
  constructor(
    public readonly code:
      | "invalid_state"
      | "expired"
      | "session_mismatch"
      | "cookie_missing"
      | "access_denied"
      | "not_configured"
      | "exchange_failed"
      | "invalid_request"
      | "forbidden"
      | "limit_reached",
    message?: string
  ) {
    super(message ?? code);
    this.name = "OAuthFlowError";
  }
}

// ---------------------------------------------------------------------------
// App credentials and redirect URI
// ---------------------------------------------------------------------------

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export function oauthClient(provider: IntegrationProvider): OAuthClient | null {
  if (!isOAuthProvider(provider)) return null;
  const clientId = process.env[`${provider}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${provider}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function isOAuthConfigured(provider: IntegrationProvider): boolean {
  return oauthClient(provider) !== null;
}

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function oauthRedirectUri(): string {
  return `${appUrl()}/api/integrations/oauth/callback`;
}

// ---------------------------------------------------------------------------
// Signed state and the flow cookie
// ---------------------------------------------------------------------------

function stateSecret(): string {
  const secret = process.env.OAUTH_STATE_SECRET || process.env.CLERK_SECRET_KEY;
  if (!secret) throw new OAuthFlowError("not_configured", "OAUTH_STATE_SECRET is not configured");
  return secret;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export const startExtraSchema = z.object({
  subdomain: z.string().max(63).optional(),
  environment: z.enum(["production", "sandbox"]).optional(),
  region: z.enum(["us", "eu", "au"]).optional(),
});
export type StartExtra = z.infer<typeof startExtraSchema>;

const cuid = z.string().regex(/^[a-z0-9]{10,40}$/i);

export const stateSchema = z.object({
  v: z.literal(1),
  orgId: cuid,
  userId: cuid,
  projectId: cuid,
  provider: z.enum(["SLACK", "HUBSPOT", "INTERCOM", "GONG", "SALESFORCE", "ZENDESK"]),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/),
  exp: z.number().int(),
  extra: startExtraSchema,
});
export type OAuthState = z.infer<typeof stateSchema>;

export function signState(state: OAuthState): string {
  const body = b64(JSON.stringify(state));
  return `${body}.${hmacSha256Hex(stateSecret(), `oauth-state|${body}`)}`;
}

/** Verify signature and expiry. Throws OAuthFlowError. */
export function verifyState(token: string | null | undefined, now = Date.now()): OAuthState {
  if (!token || token.length > 4000) throw new OAuthFlowError("invalid_state");
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new OAuthFlowError("invalid_state");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqualStr(hmacSha256Hex(stateSecret(), `oauth-state|${body}`), sig)) throw new OAuthFlowError("invalid_state");
  let parsed: OAuthState;
  try {
    parsed = stateSchema.parse(JSON.parse(unb64(body)));
  } catch {
    throw new OAuthFlowError("invalid_state");
  }
  if (parsed.exp < now) throw new OAuthFlowError("expired");
  return parsed;
}

export interface FlowCookie {
  nonce: string;
  userId: string;
  provider: OAuthProvider;
  verifier: string | null;
}

export function flowCookieName(provider: OAuthProvider): string {
  return `beacon_oauth_${provider.toLowerCase()}`;
}

export function signFlowCookie(c: FlowCookie): string {
  const body = b64(JSON.stringify(c));
  return `${body}.${hmacSha256Hex(stateSecret(), `oauth-cookie|${c.userId}|${body}`)}`;
}

export function verifyFlowCookie(value: string | null | undefined, userId: string): FlowCookie | null {
  if (!value || value.length > 4000) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  if (!timingSafeEqualStr(hmacSha256Hex(stateSecret(), `oauth-cookie|${userId}|${body}`), value.slice(dot + 1))) return null;
  try {
    const parsed = JSON.parse(unb64(body)) as FlowCookie;
    return parsed.userId === userId ? parsed : null;
  } catch {
    return null;
  }
}

export function newNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

interface ExchangeInput {
  code: string;
  client: OAuthClient;
  redirectUri: string;
  codeVerifier: string | null;
  extra: StartExtra;
}

export interface ExchangeResult {
  credentials: Credentials;
  /** Non-secret settings derived from the provider (stored in config). */
  config?: Record<string, unknown>;
  account?: Record<string, string>;
}

interface OAuthDef {
  pkce: boolean;
  authorizeUrl(p: { client: OAuthClient; redirectUri: string; state: string; codeChallenge: string | null; extra: StartExtra }): string;
  exchange(http: ProviderHttp, p: ExchangeInput): Promise<ExchangeResult>;
  /** Returns the refreshed credentials (merged with the old ones). */
  refresh?(http: ProviderHttp, creds: Credentials, client: OAuthClient, config: Record<string, unknown>): Promise<Credentials>;
  revoke?(http: ProviderHttp, creds: Credentials, client: OAuthClient, config: Record<string, unknown>): Promise<void>;
}

function url(base: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return u.toString();
}

function expiresAt(expiresIn: unknown): string | undefined {
  const n = Number(expiresIn);
  return Number.isFinite(n) && n > 0 ? new Date(Date.now() + n * 1000).toISOString() : undefined;
}

function compact(c: Record<string, string | undefined>): Credentials {
  const out: Credentials = {};
  for (const [k, v] of Object.entries(c)) if (v) out[k] = v;
  return out;
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(5000),
  refresh_token: z.string().min(1).max(5000).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
});

function parseToken<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new OAuthFlowError("exchange_failed", "The provider returned an unexpected token response");
  return parsed.data;
}

const SLACK_SCOPES = ["channels:history", "channels:read", "channels:join", "users:read", "chat:write"];

const DEFS: Record<OAuthProvider, OAuthDef> = {
  SLACK: {
    pkce: false,
    authorizeUrl: ({ client, redirectUri, state }) =>
      url("https://slack.com/oauth/v2/authorize", { client_id: client.clientId, scope: SLACK_SCOPES.join(","), redirect_uri: redirectUri, state }),
    async exchange(http, { code, client, redirectUri }) {
      const body = await http.json<Record<string, unknown>>("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        noAuth: true,
        form: { client_id: client.clientId, client_secret: client.clientSecret, code, redirect_uri: redirectUri },
      });
      if (body.ok !== true) throw new OAuthFlowError("exchange_failed", "Slack rejected the authorization code");
      const t = parseToken(
        tokenSchema.extend({ team: z.object({ id: z.string().max(40), name: z.string().max(200).optional() }).optional() }),
        body
      );
      return {
        credentials: compact({ botToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAt(t.expires_in) }),
        account: t.team ? compact({ teamId: t.team.id, teamName: t.team.name }) : undefined,
      };
    },
    async refresh(http, creds, client) {
      const body = await http.json<Record<string, unknown>>("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        noAuth: true,
        form: { client_id: client.clientId, client_secret: client.clientSecret, grant_type: "refresh_token", refresh_token: creds.refreshToken },
      });
      if (body.ok !== true) throw new ProviderAuthError("Slack", "refresh failed");
      const t = parseToken(tokenSchema, body);
      return compact({ ...creds, botToken: t.access_token, refreshToken: t.refresh_token ?? creds.refreshToken, expiresAt: expiresAt(t.expires_in) });
    },
    async revoke(http, creds) {
      await http.request("https://slack.com/api/auth.revoke", {
        method: "POST",
        noAuth: true,
        headers: { authorization: `Bearer ${creds.botToken ?? creds.accessToken ?? ""}` },
        form: {},
      });
    },
  },

  HUBSPOT: {
    pkce: false,
    authorizeUrl: ({ client, redirectUri, state }) =>
      url("https://app.hubspot.com/oauth/authorize", { client_id: client.clientId, redirect_uri: redirectUri, scope: "oauth tickets", state }),
    async exchange(http, { code, client, redirectUri }) {
      const t = parseToken(
        tokenSchema,
        await http.json("https://api.hubapi.com/oauth/v1/token", {
          method: "POST",
          noAuth: true,
          form: { grant_type: "authorization_code", client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, code },
        })
      );
      return { credentials: compact({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAt(t.expires_in) }) };
    },
    async refresh(http, creds, client) {
      const t = parseToken(
        tokenSchema,
        await http.json("https://api.hubapi.com/oauth/v1/token", {
          method: "POST",
          noAuth: true,
          form: { grant_type: "refresh_token", client_id: client.clientId, client_secret: client.clientSecret, refresh_token: creds.refreshToken },
        })
      );
      return compact({ ...creds, accessToken: t.access_token, refreshToken: t.refresh_token ?? creds.refreshToken, expiresAt: expiresAt(t.expires_in) });
    },
    async revoke(http, creds) {
      if (!creds.refreshToken) return;
      await http.request(`https://api.hubapi.com/oauth/v1/refresh-tokens/${encodeURIComponent(creds.refreshToken)}`, {
        method: "DELETE",
        noAuth: true,
        acceptStatuses: [404],
      });
    },
  },

  INTERCOM: {
    pkce: false,
    authorizeUrl: ({ client, redirectUri, state }) =>
      url("https://app.intercom.com/oauth", { client_id: client.clientId, redirect_uri: redirectUri, state }),
    async exchange(http, { code, client }) {
      const body = await http.json<Record<string, unknown>>("https://api.intercom.io/auth/eagle/token", {
        method: "POST",
        noAuth: true,
        form: { code, client_id: client.clientId, client_secret: client.clientSecret },
      });
      const token = (typeof body.access_token === "string" && body.access_token) || (typeof body.token === "string" && body.token);
      if (!token || token.length > 5000) throw new OAuthFlowError("exchange_failed", "Intercom returned an unexpected token response");
      return { credentials: { accessToken: token } };
    },
    async revoke(http, creds, _client, config) {
      const region = (config.region as string | undefined) ?? "us";
      const host = region === "eu" ? "https://api.eu.intercom.io" : region === "au" ? "https://api.au.intercom.io" : "https://api.intercom.io";
      await http.request(`${host}/auth/uninstall`, {
        method: "POST",
        noAuth: true,
        headers: { authorization: `Bearer ${creds.accessToken ?? ""}` },
        json: {},
        acceptStatuses: [401, 404],
      });
    },
  },

  GONG: {
    pkce: false,
    authorizeUrl: ({ client, redirectUri, state }) =>
      url("https://app.gong.io/oauth2/authorize", {
        client_id: client.clientId,
        response_type: "code",
        scope: "api:calls:read:extensive api:calls:read:transcript",
        redirect_uri: redirectUri,
        state,
      }),
    async exchange(http, { code, client, redirectUri }) {
      const t = parseToken(
        tokenSchema.extend({ api_base_url_for_customer: z.string().max(200) }),
        await http.json(
          url("https://app.gong.io/oauth2/generate-customer-token", {
            grant_type: "authorization_code",
            code,
            client_id: client.clientId,
            redirect_uri: redirectUri,
          }),
          { method: "POST", noAuth: true, headers: { authorization: basicAuth(client.clientId, client.clientSecret) } }
        )
      );
      return {
        credentials: compact({
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: expiresAt(t.expires_in),
          apiBaseUrl: gongBaseUrl(t.api_base_url_for_customer),
        }),
      };
    },
    async refresh(http, creds, client) {
      const t = parseToken(
        tokenSchema.extend({ api_base_url_for_customer: z.string().max(200).optional() }),
        await http.json(
          url("https://app.gong.io/oauth2/generate-customer-token", { grant_type: "refresh_token", refresh_token: creds.refreshToken }),
          { method: "POST", noAuth: true, headers: { authorization: basicAuth(client.clientId, client.clientSecret) } }
        )
      );
      return compact({
        ...creds,
        accessToken: t.access_token,
        refreshToken: t.refresh_token ?? creds.refreshToken,
        expiresAt: expiresAt(t.expires_in),
        apiBaseUrl: t.api_base_url_for_customer ? gongBaseUrl(t.api_base_url_for_customer) : creds.apiBaseUrl,
      });
    },
  },

  SALESFORCE: {
    pkce: true,
    authorizeUrl: ({ client, redirectUri, state, codeChallenge, extra }) =>
      url(`${salesforceLoginHost(extra.environment)}/services/oauth2/authorize`, {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: redirectUri,
        scope: "api refresh_token",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallenge ? "S256" : null,
      }),
    async exchange(http, { code, client, redirectUri, codeVerifier, extra }) {
      const t = parseToken(
        tokenSchema.extend({ instance_url: z.string().max(300) }),
        await http.json(`${salesforceLoginHost(extra.environment)}/services/oauth2/token`, {
          method: "POST",
          noAuth: true,
          form: {
            grant_type: "authorization_code",
            code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier ?? undefined,
          },
        })
      );
      return {
        credentials: compact({ accessToken: t.access_token, refreshToken: t.refresh_token, instanceUrl: salesforceInstanceUrl(t.instance_url) }),
        config: { environment: extra.environment ?? "production" },
      };
    },
    async refresh(http, creds, client, config) {
      const t = parseToken(
        tokenSchema.extend({ instance_url: z.string().max(300).optional() }),
        await http.json(`${salesforceLoginHost(config.environment as string | undefined)}/services/oauth2/token`, {
          method: "POST",
          noAuth: true,
          form: { grant_type: "refresh_token", refresh_token: creds.refreshToken, client_id: client.clientId, client_secret: client.clientSecret },
        })
      );
      return compact({
        ...creds,
        accessToken: t.access_token,
        instanceUrl: t.instance_url ? salesforceInstanceUrl(t.instance_url) : creds.instanceUrl,
      });
    },
    async revoke(http, creds, _client, config) {
      await http.request(`${salesforceLoginHost(config.environment as string | undefined)}/services/oauth2/revoke`, {
        method: "POST",
        noAuth: true,
        form: { token: creds.refreshToken ?? creds.accessToken },
        acceptStatuses: [400],
      });
    },
  },

  ZENDESK: {
    pkce: true,
    authorizeUrl: ({ client, redirectUri, state, codeChallenge, extra }) =>
      url(`${zendeskBaseUrl(extra.subdomain)}/oauth/authorizations/new`, {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: redirectUri,
        scope: "read",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallenge ? "S256" : null,
      }),
    async exchange(http, { code, client, redirectUri, codeVerifier, extra }) {
      const subdomain = zendeskSubdomain(extra.subdomain);
      const t = parseToken(
        tokenSchema,
        await http.json(`${zendeskBaseUrl(subdomain)}/oauth/tokens`, {
          method: "POST",
          noAuth: true,
          json: {
            grant_type: "authorization_code",
            code,
            client_id: client.clientId,
            client_secret: client.clientSecret,
            redirect_uri: redirectUri,
            scope: "read",
            ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
          },
        })
      );
      return {
        credentials: compact({ accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiresAt(t.expires_in), subdomain }),
      };
    },
    async refresh(http, creds, client) {
      const t = parseToken(
        tokenSchema,
        await http.json(`${zendeskBaseUrl(creds.subdomain)}/oauth/tokens`, {
          method: "POST",
          noAuth: true,
          json: { grant_type: "refresh_token", refresh_token: creds.refreshToken, client_id: client.clientId, client_secret: client.clientSecret, scope: "read" },
        })
      );
      return compact({ ...creds, accessToken: t.access_token, refreshToken: t.refresh_token ?? creds.refreshToken, expiresAt: expiresAt(t.expires_in) });
    },
    async revoke(http, creds) {
      await http.request(`${zendeskBaseUrl(creds.subdomain)}/api/v2/oauth/tokens/current.json`, {
        method: "DELETE",
        noAuth: true,
        headers: { authorization: `Bearer ${creds.accessToken ?? ""}` },
        acceptStatuses: [401, 404],
      });
    },
  },
};

export function oauthDef(provider: OAuthProvider): OAuthDef {
  return DEFS[provider];
}

export function supportsPkce(provider: OAuthProvider): boolean {
  return DEFS[provider].pkce;
}

export function buildAuthorizeUrl(provider: OAuthProvider, p: { state: string; codeChallenge: string | null; extra: StartExtra }): string {
  const client = oauthClient(provider);
  if (!client) throw new OAuthFlowError("not_configured");
  return DEFS[provider].authorizeUrl({ client, redirectUri: oauthRedirectUri(), state: p.state, codeChallenge: p.codeChallenge, extra: p.extra });
}

export async function exchangeCode(
  provider: OAuthProvider,
  p: { code: string; codeVerifier: string | null; extra: StartExtra }
): Promise<ExchangeResult> {
  const client = oauthClient(provider);
  if (!client) throw new OAuthFlowError("not_configured");
  const http = createProviderHttp({ provider });
  try {
    return await DEFS[provider].exchange(http, { code: p.code, client, redirectUri: oauthRedirectUri(), codeVerifier: p.codeVerifier, extra: p.extra });
  } catch (err) {
    if (err instanceof OAuthFlowError) throw err;
    if (err instanceof ProviderError || err instanceof ProviderAuthError) throw new OAuthFlowError("exchange_failed", err.message);
    throw new OAuthFlowError("exchange_failed", err instanceof Error ? err.message : "Token exchange failed");
  }
}

/** True when the provider issues refreshable tokens and these credentials carry one. */
export function canRefresh(provider: IntegrationProvider, creds: Credentials): boolean {
  return isOAuthProvider(provider) && !!DEFS[provider].refresh && !!creds.refreshToken && !!oauthClient(provider);
}

/** Refresh tokens. A rejected refresh token means the user must reconnect. */
export async function refreshCredentials(
  provider: IntegrationProvider,
  creds: Credentials,
  config: Record<string, unknown>
): Promise<Credentials> {
  if (!isOAuthProvider(provider)) return creds;
  const def = DEFS[provider];
  const client = oauthClient(provider);
  if (!def.refresh || !client || !creds.refreshToken) throw new ProviderAuthError(provider, "token expired");
  try {
    return await def.refresh(createProviderHttp({ provider }), creds, client, config);
  } catch (err) {
    if (err instanceof ProviderError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      throw new ProviderAuthError(provider, "refresh rejected");
    }
    if (err instanceof OAuthFlowError) throw new ProviderAuthError(provider, "refresh rejected");
    throw err;
  }
}

/** True when credentials expire within `withinMs`. */
export function expiresSoon(creds: Credentials, withinMs = 5 * 60_000, now = Date.now()): boolean {
  if (!creds.expiresAt) return false;
  const t = Date.parse(creds.expiresAt);
  return Number.isFinite(t) && t - now < withinMs;
}

/** Best-effort revocation at the provider. Returns whether a revoke call was made. */
export async function revokeCredentials(provider: IntegrationProvider, creds: Credentials, config: Record<string, unknown>): Promise<boolean> {
  if (!isOAuthProvider(provider)) return false;
  const def = DEFS[provider];
  const client = oauthClient(provider);
  if (!def.revoke || !client) return false;
  await def.revoke(createProviderHttp({ provider }), creds, client, config);
  return true;
}
