/**
 * SSRF-safe outbound HTTP.
 *
 * Every server-side fetch to a user-influenced destination (URL imports, webhooks,
 * competitor scans, integration hosts) must go through `safeFetch`.
 *
 * Guarantees:
 * - Only http/https (https required unless `allowHttp`).
 * - The destination IP is validated at *connect time* via a custom DNS lookup
 *   on a dedicated undici Agent, so DNS rebinding between check and connect is
 *   impossible, and every redirect hop is validated the same way.
 * - Private, loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
 *   multicast, reserved, IPv6 ULA/link-local and IPv4-mapped forms are refused.
 * - Redirects are followed manually (max 5) and re-validated per hop.
 * - Hard timeout and a response size cap (streamed, aborts when exceeded).
 */
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export class SafeFetchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_URL"
      | "BLOCKED_PROTOCOL"
      | "BLOCKED_ADDRESS"
      | "TOO_MANY_REDIRECTS"
      | "TIMEOUT"
      | "RESPONSE_TOO_LARGE"
      | "NETWORK"
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

function expandV6(ip: string): number[] | null {
  // Handle embedded IPv4 (e.g. ::ffff:1.2.3.4)
  let addr = ip.toLowerCase().split("%")[0];
  const v4Match = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const n = ipv4ToInt(v4Match[1]);
    addr = addr.replace(v4Match[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = addr.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  if (addr.includes("::")) {
    const fill = 8 - headParts.length - tailParts.length;
    if (fill < 0) return null;
    const parts = [...headParts, ...Array(fill).fill("0"), ...tailParts];
    return parts.map((p) => parseInt(p, 16));
  }
  if (headParts.length !== 8) return null;
  return headParts.map((p) => parseInt(p, 16));
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip);
  if (!h || h.some((x) => Number.isNaN(x))) return true;
  const allZeroPrefix = h.slice(0, 5).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible) -> check the v4 part
  if (allZeroPrefix && (h[5] === 0xffff || h[5] === 0)) {
    const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
    if (h[5] === 0 && h[6] === 0 && (h[7] === 0 || h[7] === 1)) return true; // :: and ::1
    return isBlockedV4(v4);
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    // NAT64 well-known prefix maps IPv4 -> check embedded v4
    const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
    return isBlockedV4(v4);
  }
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

/** DNS lookup that refuses blocked addresses. Used by the Agent at connect time. */
function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback
): void {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as Array<{ address: string; family: number }>;
    const blocked = list.find((a) => isBlockedAddress(a.address));
    if (blocked || list.length === 0) {
      const e = new Error(`Destination ${hostname} resolves to a blocked address`) as NodeJS.ErrnoException;
      e.code = "EBLOCKEDADDRESS";
      return callback(e, []);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const agents = new Map<string, Dispatcher>();

/**
 * Guarded agent per (headers, body) timeout pair. Most calls use the defaults;
 * slow APIs that only respond when work is done (e.g. Deepgram transcription of
 * a long recording) pass longer timeouts and get their own guarded pool.
 */
function guardedAgent(headersTimeoutMs = DEFAULT_HEADERS_TIMEOUT_MS, bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS): Dispatcher {
  const key = `${headersTimeoutMs}:${bodyTimeoutMs}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: guardedLookup as never },
      headersTimeout: headersTimeoutMs,
      bodyTimeout: bodyTimeoutMs,
    });
    agents.set(key, agent);
  }
  return agent;
}

export interface SafeFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowHttp?: boolean;
  /** Max wait for response headers (default 15s). Raise for APIs that reply only when done. */
  headersTimeoutMs?: number;
  /** Max idle time between body chunks (default 30s). */
  bodyTimeoutMs?: number;
  /**
   * Test-only: origins (e.g. "http://127.0.0.1:4010") exempt from address checks.
   * Every other hop, including redirects, is still validated. Ignored unless
   * NODE_ENV=test.
   */
  unsafeTestAllowOrigins?: string[];
}

export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  url: string;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

function validateUrl(raw: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("Invalid URL", "INVALID_URL");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new SafeFetchError(`Protocol ${url.protocol} is not allowed`, "BLOCKED_PROTOCOL");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("Credentials in URLs are not allowed", "INVALID_URL");
  }
  // Literal IPs never go through DNS, so check them here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) {
    throw new SafeFetchError("Destination address is not allowed", "BLOCKED_ADDRESS");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new SafeFetchError("Destination host is not allowed", "BLOCKED_ADDRESS");
  }
  return url;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const testOrigins = process.env.NODE_ENV === "test" ? new Set(opts.unsafeTestAllowOrigins ?? []) : new Set<string>();
  const exempt = (u: string) => {
    try {
      return testOrigins.has(new URL(u).origin);
    } catch {
      return false;
    }
  };
  const resolve = (u: string) => (exempt(u) ? new URL(u) : validateUrl(u, opts.allowHttp ?? false));
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const signal = AbortSignal.timeout(timeoutMs);

  let current = resolve(rawUrl);
  let method = opts.method ?? "GET";
  let body = opts.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(current, {
        method,
        headers: { "user-agent": "BeaconBot/1.0", ...(opts.headers ?? {}) },
        body: body as never,
        redirect: "manual",
        signal,
        dispatcher: exempt(current.toString()) ? undefined : guardedAgent(opts.headersTimeoutMs, opts.bodyTimeoutMs),
      });
    } catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        throw new SafeFetchError("Request timed out", "TIMEOUT");
      }
      if (e.cause?.code === "EBLOCKEDADDRESS") {
        throw new SafeFetchError("Destination address is not allowed", "BLOCKED_ADDRESS");
      }
      throw new SafeFetchError("Network error", "NETWORK");
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => undefined);
      if (hop === maxRedirects) throw new SafeFetchError("Too many redirects", "TOO_MANY_REDIRECTS");
      const next = new URL(res.headers.get("location")!, current);
      current = resolve(next.toString());
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    // Stream the body with a hard size cap.
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new SafeFetchError("Response too large", "RESPONSE_TOO_LARGE");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new SafeFetchError("Response too large", "RESPONSE_TOO_LARGE");
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    const buf = Buffer.concat(chunks);
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers as unknown as Headers,
      url: current.toString(),
      body: buf,
      text: () => buf.toString("utf8"),
      json: <T,>() => JSON.parse(buf.toString("utf8")) as T,
    };
  }
  throw new SafeFetchError("Too many redirects", "TOO_MANY_REDIRECTS");
}
