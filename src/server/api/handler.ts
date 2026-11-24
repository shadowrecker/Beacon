/**
 * REST API v1 request handling: one entry point for the catch-all route.
 *
 * Order: route match -> API key auth -> per-key rate limit (429 + Retry-After)
 * -> scope check -> size-capped JSON body + zod validation -> handler ->
 * ApiUsage row. Error bodies are generic (`{ error: { code, message } }`);
 * internal errors are logged with a request ID and never echoed.
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { extractApiKey, hasScope, validateApiKey, type ApiKeyPrincipal } from "./auth";
import { ApiError, errorResponse, json, parseOrThrow, readJsonBody } from "./http";
import { matchRoute, type HttpMethod, type RouteDefinition } from "./routes";
import { buildOpenApiDocument } from "./openapi";

const BASE_PATH = "/api/v1";
const TRPC_STATUS: Partial<Record<TRPCError["code"], number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_REQUESTS: 429,
};

/** Truncate an IP for usage records: /24 for IPv4, /48 for IPv6. Never the full address. */
export function truncateIp(raw: string | null): string | null {
  if (!raw) return null;
  const ip = raw.split(",")[0].trim();
  if (isIP(ip) === 4) return ip.split(".").slice(0, 3).concat("0").join(".");
  if (isIP(ip) === 6) {
    const groups = ip.split(":").filter(Boolean).slice(0, 3);
    return `${groups.join(":")}::/48`;
  }
  return null;
}

function routePath(url: URL): string {
  const p = url.pathname;
  return p.startsWith(BASE_PATH) ? p.slice(BASE_PATH.length) || "/" : p;
}

function queryObject(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of url.searchParams) {
    if (++n > 20) break;
    out[k.slice(0, 64)] = v.slice(0, 500);
  }
  return out;
}

async function recordUsage(key: ApiKeyPrincipal, req: Request, route: RouteDefinition | null, method: string, status: number, started: number, requestSize: number, responseSize: number) {
  try {
    await prisma.apiUsage.create({
      data: {
        apiKeyId: key.id,
        // The route template (not the raw path) so IDs aren't stored and usage groups by endpoint.
        endpoint: route ? route.path : "(unmatched)",
        method,
        statusCode: status,
        latencyMs: Date.now() - started,
        requestSize,
        responseSize,
        ipAddress: truncateIp(req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip")),
        userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
      },
    });
  } catch (err) {
    logger.warn("api usage record failed", { err });
  }
}

export async function handleApiRequest(req: Request): Promise<Response> {
  const started = Date.now();
  const requestId = req.headers.get("x-request-id")?.slice(0, 100) || randomUUID();
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  const path = routePath(url);
  const log = logger.child({ component: "api-v1", requestId });

  if (path === "/openapi.json") {
    if (method !== "GET") return errorResponse(new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed"), requestId, { allow: "GET" });
    return json(200, buildOpenApiDocument(), { "cache-control": "public, max-age=300" });
  }

  // Authenticate before routing details are revealed.
  const auth = await validateApiKey(extractApiKey(req.headers));
  if (!auth.valid) {
    const message = auth.reason === "missing" ? "Missing API key. Send Authorization: Bearer <key>." : "Invalid or revoked API key";
    return errorResponse(new ApiError(401, "UNAUTHORIZED", message), requestId, { "www-authenticate": 'Bearer realm="beacon"' });
  }
  const key = auth.key;

  const limit = await checkRateLimit({ name: "api-key", limit: key.rateLimit, windowMs: 60_000 }, key.id);
  const rateHeaders = {
    "x-ratelimit-limit": String(key.rateLimit),
    "x-ratelimit-remaining": String(limit.remaining),
    "x-ratelimit-reset": String(Math.ceil(limit.resetMs / 1000)),
  };
  if (!limit.allowed) {
    return errorResponse(new ApiError(429, "RATE_LIMITED", "Rate limit exceeded"), requestId, {
      ...rateHeaders,
      "retry-after": String(Math.max(1, Math.ceil(limit.resetMs / 1000))),
    });
  }

  const match = matchRoute(method, path);
  let route: RouteDefinition | null = null;
  let requestSize = 0;
  let response: Response;
  try {
    if (match.kind === "not_found") throw new ApiError(404, "NOT_FOUND", "Endpoint not found");
    if (match.kind === "method_not_allowed") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    route = match.route;
    if (!hasScope(key, route.scope)) {
      throw new ApiError(403, "INSUFFICIENT_SCOPE", `This API key lacks the required scope: ${route.scope}`);
    }
    const params = route.params ? parseOrThrow(route.params, match.params, "path parameters") : {};
    const query = route.query ? parseOrThrow(route.query, queryObject(url), "query parameters") : {};
    let body: unknown = undefined;
    if (route.body) {
      const read = await readJsonBody(req);
      requestSize = read.bytes;
      body = parseOrThrow(route.body, read.value ?? {}, "request body");
    }
    const result = await route.handler({ key, params, query, body });
    response = json(route.status ?? 200, result, { ...rateHeaders, "x-request-id": requestId });
  } catch (err) {
    let apiErr: ApiError;
    if (err instanceof ApiError) apiErr = err;
    else if (err instanceof TRPCError && TRPC_STATUS[err.code]) apiErr = new ApiError(TRPC_STATUS[err.code]!, err.code, err.message);
    else {
      log.error("api request failed", { err, method, endpoint: route?.path ?? path });
      apiErr = new ApiError(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
    }
    const extra: Record<string, string> = { ...rateHeaders, "x-request-id": requestId };
    if (match.kind === "method_not_allowed") extra.allow = match.allow.join(", ");
    response = errorResponse(apiErr, requestId, extra);
  }

  const responseSize = Number(response.headers.get("content-length") ?? "0") || 0;
  await recordUsage(key, req, route, method as HttpMethod, response.status, started, requestSize, responseSize);
  return response;
}
