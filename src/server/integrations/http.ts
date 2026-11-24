/**
 * Outbound HTTP for integration connectors and OAuth.
 *
 * Every provider request goes through `safeFetch` (SSRF guard, timeout, size
 * cap) via a swappable transport, so tests can serve recorded fixtures without
 * network access. On top of that this module adds:
 *
 * - 429 handling: a short `Retry-After` is honored inline (bounded); a longer
 *   one throws a `ProviderError` with status 429 so the job framework retries
 *   the job with backoff (429 is classified as retryable).
 * - 401 handling: one transparent token refresh via `onUnauthorized`, then a
 *   `ProviderAuthError` (non-retryable: the user must reconnect).
 * - Errors carry only the provider name, status and a short provider error code,
 *   never the response body (it can echo request details).
 */
import { safeFetch, SafeFetchError, type SafeFetchOptions, type SafeFetchResponse } from "@/lib/safe-fetch";
import { NonRetryableError } from "../jobs/worker";

export type HttpTransport = (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResponse>;

let transport: HttpTransport = safeFetch;
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** Test-only: replace the network transport (null restores safeFetch). */
export function setIntegrationTransportForTests(t: HttpTransport | null): void {
  transport = t ?? safeFetch;
}

/** Test-only: replace the inline retry sleep. */
export function setIntegrationSleepForTests(fn: ((ms: number) => Promise<void>) | null): void {
  sleepFn = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

/** A failed provider request. `status` drives retry classification in the job framework. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly status: number,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Credentials were rejected: the integration must be reconnected. */
export class ProviderAuthError extends NonRetryableError {
  constructor(public readonly provider: string, detail?: string) {
    super(`${provider} rejected the stored credentials${detail ? ` (${detail})` : ""}. Reconnect the integration.`);
    this.name = "ProviderAuthError";
  }
}

/** Max wait honored inline for a Retry-After before handing the retry to the job framework. */
const INLINE_RETRY_MAX_MS = 20_000;
const INLINE_RETRIES = 2;

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** JSON body (serialized; sets content-type). */
  json?: unknown;
  /** Form-encoded body. */
  form?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxBytes?: number;
  /** Skip the provider auth headers (OAuth token endpoints). */
  noAuth?: boolean;
  /** Statuses that should be returned to the caller instead of thrown. */
  acceptStatuses?: number[];
}

export function withQuery(url: string, query?: RequestOptions["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Short, safe provider error code from a JSON error body (never the whole body). */
function errorCode(res: SafeFetchResponse): string | undefined {
  try {
    const body = res.json<Record<string, unknown>>();
    const raw = body?.error ?? body?.code ?? body?.errorCode ?? (Array.isArray(body?.errors) ? (body.errors[0] as Record<string, unknown>)?.code : undefined);
    const code = typeof raw === "string" ? raw : typeof raw === "object" && raw && typeof (raw as { code?: unknown }).code === "string" ? (raw as { code: string }).code : undefined;
    return code && /^[\w.:-]{1,60}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export interface ProviderHttpOptions {
  provider: string;
  /** Auth headers for the current credentials (re-read after a refresh). */
  authHeaders?: () => Record<string, string>;
  /** Called once on a 401; return true if credentials were refreshed and the request should be retried. */
  onUnauthorized?: () => Promise<boolean>;
}

export interface ProviderHttp {
  provider: string;
  request(url: string, opts?: RequestOptions): Promise<SafeFetchResponse>;
  json<T>(url: string, opts?: RequestOptions): Promise<T>;
}

export function createProviderHttp(options: ProviderHttpOptions): ProviderHttp {
  const { provider } = options;

  async function request(url: string, opts: RequestOptions = {}): Promise<SafeFetchResponse> {
    const target = withQuery(url, opts.query);
    let refreshed = false;
    let inlineRetries = 0;

    for (;;) {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...(opts.noAuth ? {} : options.authHeaders?.() ?? {}),
        ...(opts.headers ?? {}),
      };
      let body: string | undefined;
      if (opts.json !== undefined) {
        body = JSON.stringify(opts.json);
        headers["content-type"] ??= "application/json";
      } else if (opts.form) {
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.form)) if (v !== undefined) form.set(k, v);
        body = form.toString();
        headers["content-type"] ??= "application/x-www-form-urlencoded";
      }

      let res: SafeFetchResponse;
      try {
        res = await transport(target, {
          method: opts.method ?? (body !== undefined ? "POST" : "GET"),
          headers,
          body,
          timeoutMs: opts.timeoutMs ?? 30_000,
          maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
          maxRedirects: 3,
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          if (err.code === "TIMEOUT" || err.code === "NETWORK") {
            throw new ProviderError(`${provider} request failed (${err.code.toLowerCase()})`, provider, 503);
          }
          if (err.code === "RESPONSE_TOO_LARGE") {
            throw new NonRetryableError(`${provider} returned a response larger than allowed`);
          }
          throw new NonRetryableError(`${provider} request was blocked (${err.code.toLowerCase()})`);
        }
        throw err;
      }

      if (opts.acceptStatuses?.includes(res.status)) return res;

      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get("retry-after"));
        if (wait !== undefined && wait <= INLINE_RETRY_MAX_MS && inlineRetries < INLINE_RETRIES) {
          inlineRetries++;
          await sleepFn(wait);
          continue;
        }
        throw new ProviderError(`${provider} rate limit reached; retrying later`, provider, 429, wait);
      }

      if (res.status === 401 && !opts.noAuth) {
        if (!refreshed && options.onUnauthorized) {
          refreshed = true;
          if (await options.onUnauthorized()) continue;
        }
        throw new ProviderAuthError(provider, errorCode(res));
      }

      if (!res.ok) {
        const code = errorCode(res);
        throw new ProviderError(`${provider} request failed with status ${res.status}${code ? ` (${code})` : ""}`, provider, res.status);
      }
      return res;
    }
  }

  return {
    provider,
    request,
    async json<T>(url: string, opts?: RequestOptions): Promise<T> {
      const res = await request(url, opts);
      if (res.status === 204 || res.body.length === 0) return {} as T;
      try {
        return res.json<T>();
      } catch {
        throw new ProviderError(`${provider} returned a response that is not valid JSON`, provider, 502);
      }
    },
  };
}

/** Basic auth header value. */
export function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}
