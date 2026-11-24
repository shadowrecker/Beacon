/**
 * OAuth start and callback logic, independent of Next.js so it can be tested
 * directly. The route handlers in src/app/api/integrations/oauth/* only
 * resolve the signed-in user and translate the result into a redirect + cookie.
 *
 * Start (authenticated): the caller must hold integrations:manage in the
 *   project's org. Returns the provider authorize URL and a flow cookie.
 * Callback (public route): verifies the state signature and expiry, that the
 *   flow cookie is present, bound to the same user and carries the same nonce,
 *   and that the signed-in user is the one who started the flow; re-checks
 *   authorization; exchanges the code server-side; stores encrypted tokens.
 */
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { timingSafeEqualStr } from "@/lib/crypto";
import { requireOrgPermission, requireProjectAccess } from "../auth/access";
import { assertCanCreate } from "../usage/entitlements";
import { createProviderHttp } from "./http";
import { getConnector, isOAuthProvider, providerInfo, type OAuthProvider } from "./index";
import {
  buildAuthorizeUrl,
  exchangeCode,
  flowCookieName,
  isOAuthConfigured,
  newNonce,
  OAuthFlowError,
  pkcePair,
  signFlowCookie,
  signState,
  startExtraSchema,
  STATE_TTL_MS,
  supportsPkce,
  verifyFlowCookie,
  verifyState,
  type StartExtra,
} from "./oauth";
import { saveConnectedIntegration } from "./service";
import { zendeskSubdomain } from "./zendesk";

export interface FlowCookieOut {
  name: string;
  value: string;
  maxAgeSec: number;
  path: string;
}

export const FLOW_COOKIE_PATH = "/api/integrations/oauth";

function accessCtx(userId: string) {
  return { prisma, user: { id: userId } };
}

function mapAuthzError(err: unknown): never {
  if (err instanceof TRPCError) {
    if (err.code === "FORBIDDEN") throw new OAuthFlowError(err.message.includes("plan allows") ? "limit_reached" : "forbidden", err.message);
    throw new OAuthFlowError("forbidden", "Project not found");
  }
  throw err;
}

async function authorize(userId: string, projectId: string): Promise<{ orgId: string; projectId: string }> {
  try {
    const project = await requireProjectAccess(accessCtx(userId), projectId, "project:write");
    await requireOrgPermission(accessCtx(userId), project.orgId, "integrations:manage");
    return { orgId: project.orgId, projectId: project.id };
  } catch (err) {
    mapAuthzError(err);
  }
}

export async function beginOAuth(input: {
  userId: string;
  params: URLSearchParams;
}): Promise<{ redirectUrl: string; cookie: FlowCookieOut; provider: OAuthProvider }> {
  const providerRaw = (input.params.get("provider") ?? "").toUpperCase();
  if (!isOAuthProvider(providerRaw as never)) throw new OAuthFlowError("invalid_request", "Unknown OAuth provider");
  const provider = providerRaw as OAuthProvider;
  const projectId = input.params.get("projectId") ?? "";
  if (!/^[a-z0-9]{10,40}$/i.test(projectId)) throw new OAuthFlowError("invalid_request", "Choose a target project");
  if (!isOAuthConfigured(provider)) throw new OAuthFlowError("not_configured");

  const { orgId } = await authorize(input.userId, projectId);

  const existing = await prisma.integration.findUnique({ where: { orgId_provider: { orgId, provider } }, select: { id: true } });
  if (!existing) {
    try {
      await assertCanCreate(orgId, "integrations");
    } catch (err) {
      mapAuthzError(err);
    }
  }

  const extraParsed = startExtraSchema.safeParse({
    subdomain: input.params.get("subdomain") ?? undefined,
    environment: input.params.get("environment") ?? undefined,
    region: input.params.get("region") ?? undefined,
  });
  if (!extraParsed.success) throw new OAuthFlowError("invalid_request", "Invalid connection settings");
  const extra: StartExtra = extraParsed.data;
  if (provider === "ZENDESK") {
    try {
      extra.subdomain = zendeskSubdomain(extra.subdomain);
    } catch {
      throw new OAuthFlowError("invalid_request", "Enter a valid Zendesk subdomain");
    }
  } else {
    delete extra.subdomain;
  }
  if (provider !== "SALESFORCE") delete extra.environment;
  if (provider !== "INTERCOM") delete extra.region;

  const nonce = newNonce();
  const pkce = supportsPkce(provider) ? pkcePair() : null;
  const state = signState({
    v: 1,
    orgId,
    userId: input.userId,
    projectId,
    provider,
    nonce,
    exp: Date.now() + STATE_TTL_MS,
    extra,
  });
  const redirectUrl = buildAuthorizeUrl(provider, { state, codeChallenge: pkce?.challenge ?? null, extra });
  return {
    provider,
    redirectUrl,
    cookie: {
      name: flowCookieName(provider),
      value: signFlowCookie({ nonce, userId: input.userId, provider, verifier: pkce?.verifier ?? null }),
      maxAgeSec: Math.floor(STATE_TTL_MS / 1000),
      path: FLOW_COOKIE_PATH,
    },
  };
}

export interface CallbackResult {
  /** Path to redirect to (always same-origin). */
  redirectPath: string;
  /** Cookie to clear, when the state identified the provider. */
  clearCookie: string | null;
}

export function errorRedirect(code: string, provider?: string): string {
  const qs = new URLSearchParams({ oauth_error: code });
  if (provider) qs.set("provider", provider);
  return `/integrations?${qs.toString()}`;
}

export async function completeOAuth(input: {
  /** Internal user id of the signed-in user (null when signed out). */
  userId: string | null;
  params: URLSearchParams;
  readCookie: (name: string) => string | undefined;
}): Promise<CallbackResult> {
  let provider: OAuthProvider | undefined;
  try {
    const state = verifyState(input.params.get("state"));
    provider = state.provider;
    if (!input.userId || input.userId !== state.userId) throw new OAuthFlowError("session_mismatch");
    const cookie = verifyFlowCookie(input.readCookie(flowCookieName(state.provider)), input.userId);
    if (!cookie) throw new OAuthFlowError("cookie_missing");
    if (cookie.provider !== state.provider || !timingSafeEqualStr(cookie.nonce, state.nonce)) throw new OAuthFlowError("invalid_state");

    if (input.params.get("error")) throw new OAuthFlowError("access_denied");
    const code = input.params.get("code");
    if (!code || code.length > 4000) throw new OAuthFlowError("invalid_request", "Missing authorization code");

    const { orgId, projectId } = await authorize(input.userId, state.projectId);
    if (orgId !== state.orgId) throw new OAuthFlowError("forbidden");

    const result = await exchangeCode(state.provider, { code, codeVerifier: cookie.verifier, extra: state.extra });

    // Account details (workspace name, ids used for links); best effort.
    const connector = getConnector(state.provider);
    const config: Record<string, unknown> = { ...(result.config ?? {}), ...(state.extra.region ? { region: state.extra.region } : {}) };
    let account: Record<string, string> = { ...(result.account ?? {}) };
    let accountLabel: string | undefined = result.account?.teamName;
    try {
      const http = createProviderHttp({ provider: providerInfo(state.provider).name, authHeaders: () => connector.authHeaders(result.credentials, config) });
      const test = await connector.testConnection(http, result.credentials, config);
      account = { ...account, ...(test.account ?? {}) };
      accountLabel = test.accountLabel ?? accountLabel;
    } catch (err) {
      logger.warn("post-connect account lookup failed", { provider: state.provider, err });
    }

    try {
      await saveConnectedIntegration({
        orgId,
        userId: input.userId,
        provider: state.provider,
        projectId,
        credentials: result.credentials,
        config,
        account: Object.keys(account).length ? account : undefined,
        accountLabel,
      });
    } catch (err) {
      mapAuthzError(err);
    }
    return { redirectPath: `/integrations?connected=${state.provider}`, clearCookie: flowCookieName(state.provider) };
  } catch (err) {
    const code = err instanceof OAuthFlowError ? err.code : "exchange_failed";
    if (!(err instanceof OAuthFlowError)) logger.error("oauth callback failed", { provider, err });
    else logger.warn("oauth callback rejected", { provider, code });
    return { redirectPath: errorRedirect(code, provider), clearCookie: provider ? flowCookieName(provider) : null };
  }
}
