/**
 * HTTP primitives for the REST API: typed errors with generic, safe bodies,
 * JSON responses and size-capped body parsing.
 */
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
export const badRequest = (message: string, details?: Array<{ path: string; message: string }>) =>
  new ApiError(400, "BAD_REQUEST", message, details);
export const conflict = (message: string) => new ApiError(409, "CONFLICT", message);
export const forbidden = (message: string) => new ApiError(403, "FORBIDDEN", message);

/** Max JSON request body. Documents may carry up to ~1 MB of text. */
export const MAX_BODY_BYTES = 1_100_000;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(text)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

export function errorResponse(err: ApiError, requestId: string, headers: Record<string, string> = {}): Response {
  return json(
    err.status,
    { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), requestId } },
    headers
  );
}

/** Read a JSON body with a hard size cap (streamed, so a lying content-length can't bypass it). */
export async function readJsonBody(req: Request): Promise<{ value: unknown; bytes: number }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  const type = req.headers.get("content-type") ?? "";
  if (!req.body) return { value: undefined, bytes: 0 };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    }
    chunks.push(value);
  }
  if (total === 0) return { value: undefined, bytes: 0 };
  if (!/^application\/json\b/i.test(type)) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json");
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try {
    return { value: JSON.parse(text), bytes: total };
  } catch {
    throw badRequest("Request body is not valid JSON");
  }
}

export function zodDetails(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

export function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown, where: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest(`Invalid ${where}`, zodDetails(r.error));
  return r.data;
}
