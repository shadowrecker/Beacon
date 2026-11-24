/**
 * Beacon API SDK: the official JavaScript/TypeScript client for the Beacon
 * REST API v1 (see GET /api/v1/openapi.json for the full specification).
 *
 *   import { BeaconClient } from "@beacon-intelligence/sdk";
 *   const beacon = new BeaconClient({ apiKey: process.env.BEACON_API_KEY!, baseUrl: "https://app.example.com/api/v1" });
 *   const { data: projects } = await beacon.listProjects();
 *
 * Errors are thrown as typed subclasses of BeaconError (auth, permission,
 * not found, validation, rate limit, server). Webhook receivers can verify
 * deliveries with `verifyWebhookSignature`.
 */

// ---------------------------------------------------------------------------
// Types (mirror the OpenAPI component schemas)
// ---------------------------------------------------------------------------

export interface BeaconClientOptions {
  /** API key (`bk_live_…`) created under Developer → API keys. */
  apiKey: string;
  /** Base URL of the API, including `/api/v1`. */
  baseUrl?: string;
  /** Custom fetch implementation (defaults to the global fetch). */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds (default 30 000). */
  timeoutMs?: number;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface Item<T> {
  data: T;
}

export interface PageOptions {
  limit?: number;
  cursor?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  counts: { documents: number; syntheses: number; recommendations: number };
}

export type DocumentType = "TRANSCRIPT" | "SUPPORT_TICKET" | "NOTE" | "CALL_RECORDING" | "OTHER";
export type ProcessingStatus = "PENDING" | "PROCESSING" | "READY" | "FAILED";

export interface BeaconDocument {
  id: string;
  projectId: string;
  title: string;
  type: DocumentType;
  source: string;
  status: ProcessingStatus;
  mimeType: string | null;
  fileSize: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
}

export interface BeaconDocumentDetail extends BeaconDocument {
  characterCount: number;
}

export type SynthesisType = "THEMES" | "PAIN_POINTS" | "FEATURE_REQUESTS" | "FULL";

export interface Synthesis {
  id: string;
  projectId: string;
  type: SynthesisType;
  status: ProcessingStatus;
  errorMessage: string | null;
  themeCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  sentiment: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";
  confidence: number;
  citationCount: number;
}

export interface SynthesisDetail extends Synthesis {
  themes: Theme[];
}

export type RecommendationStatus = "DRAFT" | "ACCEPTED" | "REJECTED" | "IMPLEMENTED";

export interface Recommendation {
  id: string;
  projectId: string;
  synthesisId: string | null;
  title: string;
  description: string;
  impact: "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  status: RecommendationStatus;
  segments: string[];
  hasBrief: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceInsight {
  id: string;
  recordingId: string;
  summary: string;
  keyPoints: unknown[];
  painPoints: unknown[];
  actionItems: unknown[];
  sentimentScore: number;
  themes: string[];
  createdAt: string;
}

export interface VoiceRecording {
  id: string;
  projectId: string | null;
  title: string | null;
  duration: number;
  status: "RECORDING" | "UPLOADING" | "TRANSCRIBING" | "ANALYZING" | "READY" | "FAILED";
  documentId: string | null;
  recordedAt: string;
  processedAt: string | null;
  createdAt: string;
}

export interface VoiceRecordingDetail extends VoiceRecording {
  insight: VoiceInsight | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorDetail {
  path: string;
  message: string;
}

export class BeaconError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: ErrorDetail[];

  constructor(status: number, code: string, message: string, requestId: string | null = null, details: ErrorDetail[] = []) {
    super(message);
    this.name = "BeaconError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/** 401: missing, invalid, revoked or expired key. */
export class BeaconAuthenticationError extends BeaconError {
  constructor(...args: ConstructorParameters<typeof BeaconError>) {
    super(...args);
    this.name = "BeaconAuthenticationError";
  }
}

/** 403: the key lacks the required scope, or a plan limit was reached. */
export class BeaconPermissionError extends BeaconError {
  constructor(...args: ConstructorParameters<typeof BeaconError>) {
    super(...args);
    this.name = "BeaconPermissionError";
  }
}

/** 404: the resource does not exist in the key's workspace. */
export class BeaconNotFoundError extends BeaconError {
  constructor(...args: ConstructorParameters<typeof BeaconError>) {
    super(...args);
    this.name = "BeaconNotFoundError";
  }
}

/** 400/413/415/422: the request was invalid. `details` lists field problems. */
export class BeaconValidationError extends BeaconError {
  constructor(...args: ConstructorParameters<typeof BeaconError>) {
    super(...args);
    this.name = "BeaconValidationError";
  }
}

/** 409: the request conflicts with the current state (e.g. a synthesis is already running). */
export class BeaconConflictError extends BeaconError {
  constructor(...args: ConstructorParameters<typeof BeaconError>) {
    super(...args);
    this.name = "BeaconConflictError";
  }
}

/** 429: rate limited. `retryAfterSeconds` comes from the Retry-After header. */
export class BeaconRateLimitError extends BeaconError {
  readonly retryAfterSeconds: number | null;
  constructor(status: number, code: string, message: string, requestId: string | null, details: ErrorDetail[], retryAfterSeconds: number | null) {
    super(status, code, message, requestId, details);
    this.name = "BeaconRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 5xx, network errors and timeouts. */
export class BeaconServerError extends BeaconError {
  constructor(...args: ConstructorParameters<typeof BeaconError>) {
    super(...args);
    this.name = "BeaconServerError";
  }
}

function errorFor(status: number, code: string, message: string, requestId: string | null, details: ErrorDetail[], retryAfter: string | null): BeaconError {
  if (status === 401) return new BeaconAuthenticationError(status, code, message, requestId, details);
  if (status === 403) return new BeaconPermissionError(status, code, message, requestId, details);
  if (status === 404) return new BeaconNotFoundError(status, code, message, requestId, details);
  if (status === 409) return new BeaconConflictError(status, code, message, requestId, details);
  if (status === 429) {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
    return new BeaconRateLimitError(status, code, message, requestId, details, seconds);
  }
  if (status >= 500) return new BeaconServerError(status, code, message, requestId, details);
  if (status >= 400) return new BeaconValidationError(status, code, message, requestId, details);
  return new BeaconError(status, code, message, requestId, details);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^bk_live_[A-Za-z0-9_-]{43}$/;
const DEFAULT_BASE_URL = "https://app.beacon.app/api/v1";

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Query = Record<string, string | number | undefined>;

function statusParam(status: string | string[] | undefined): string | undefined {
  if (status === undefined) return undefined;
  return Array.isArray(status) ? status.join(",") : status;
}

function seg(value: string): string {
  if (!value) throw new TypeError("IDs must be non-empty strings");
  return encodeURIComponent(value);
}

export class BeaconClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BeaconClientOptions) {
    if (!options || !options.apiKey) throw new TypeError("An API key is required");
    if (!KEY_PATTERN.test(options.apiKey)) throw new TypeError('Invalid API key format: keys look like "bk_live_…"');
    const fetchImpl = options.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    if (!fetchImpl) throw new TypeError("No fetch implementation available; pass options.fetch");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request<T>(method: Method, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      throw new BeaconServerError(0, aborted ? "TIMEOUT" : "NETWORK_ERROR", aborted ? "The request timed out" : "Network error");
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) {
      const e = (parsed as { error?: { code?: string; message?: string; requestId?: string; details?: ErrorDetail[] } } | undefined)?.error;
      throw errorFor(
        response.status,
        e?.code ?? `HTTP_${response.status}`,
        e?.message ?? `Request failed with status ${response.status}`,
        e?.requestId ?? response.headers.get("x-request-id"),
        Array.isArray(e?.details) ? e!.details : [],
        response.headers.get("retry-after")
      );
    }
    if (parsed === undefined) throw new BeaconServerError(response.status, "INVALID_RESPONSE", "The API returned an invalid response");
    return parsed as T;
  }

  // Projects ---------------------------------------------------------------

  /** List projects (scope: projects:read). */
  listProjects(options: PageOptions = {}): Promise<Page<Project>> {
    return this.request("GET", "/projects", { query: { limit: options.limit, cursor: options.cursor } });
  }

  /** Create a project (scope: projects:write). */
  createProject(input: { name: string; description?: string }): Promise<Item<Project>> {
    return this.request("POST", "/projects", { body: input });
  }

  /** Get a project (scope: projects:read). */
  getProject(projectId: string): Promise<Item<Project>> {
    return this.request("GET", `/projects/${seg(projectId)}`);
  }

  /** Rename or re-describe a project (scope: projects:write). */
  updateProject(projectId: string, input: { name?: string; description?: string | null }): Promise<Item<Project>> {
    return this.request("PATCH", `/projects/${seg(projectId)}`, { body: input });
  }

  // Documents --------------------------------------------------------------

  /** List documents in a project, optionally filtered by one or more statuses (scope: documents:read). */
  listDocuments(projectId: string, options: PageOptions & { status?: ProcessingStatus | ProcessingStatus[] } = {}): Promise<Page<BeaconDocument>> {
    return this.request("GET", `/projects/${seg(projectId)}/documents`, {
      query: { limit: options.limit, cursor: options.cursor, status: statusParam(options.status) },
    });
  }

  /** Add a text document; processing is asynchronous (scope: documents:write). */
  createDocument(projectId: string, input: { title: string; text: string; type?: DocumentType }): Promise<Item<BeaconDocument>> {
    return this.request("POST", `/projects/${seg(projectId)}/documents`, { body: input });
  }

  /** Get a document's metadata and processing status (scope: documents:read). */
  getDocument(projectId: string, documentId: string): Promise<Item<BeaconDocumentDetail>> {
    return this.request("GET", `/projects/${seg(projectId)}/documents/${seg(documentId)}`);
  }

  /** Delete a document (scope: documents:write). */
  deleteDocument(projectId: string, documentId: string): Promise<Item<{ id: string; deleted: true }>> {
    return this.request("DELETE", `/projects/${seg(projectId)}/documents/${seg(documentId)}`);
  }

  // Syntheses --------------------------------------------------------------

  /** List syntheses in a project (scope: synthesis:read). */
  listSyntheses(projectId: string, options: PageOptions = {}): Promise<Page<Synthesis>> {
    return this.request("GET", `/projects/${seg(projectId)}/syntheses`, { query: { limit: options.limit, cursor: options.cursor } });
  }

  /** Get a synthesis with its themes (scope: synthesis:read). */
  getSynthesis(projectId: string, synthesisId: string): Promise<Item<SynthesisDetail>> {
    return this.request("GET", `/projects/${seg(projectId)}/syntheses/${seg(synthesisId)}`);
  }

  /** Start a synthesis; poll getSynthesis until READY or FAILED (scope: synthesis:write). */
  runSynthesis(projectId: string, input: { type?: SynthesisType } = {}): Promise<Item<Synthesis>> {
    return this.request("POST", `/projects/${seg(projectId)}/syntheses`, { body: input });
  }

  // Recommendations --------------------------------------------------------

  /** List recommendations in a project (scope: recommendations:read). */
  listRecommendations(projectId: string, options: PageOptions & { status?: RecommendationStatus | RecommendationStatus[] } = {}): Promise<Page<Recommendation>> {
    return this.request("GET", `/projects/${seg(projectId)}/recommendations`, {
      query: { limit: options.limit, cursor: options.cursor, status: statusParam(options.status) },
    });
  }

  // Voice ------------------------------------------------------------------

  /** List voice recordings, optionally for one project (scope: voice:read). */
  listVoiceRecordings(options: PageOptions & { projectId?: string } = {}): Promise<Page<VoiceRecording>> {
    return this.request("GET", "/voice/recordings", {
      query: { limit: options.limit, cursor: options.cursor, projectId: options.projectId },
    });
  }

  /** Get a voice recording and its insight (scope: voice:read). */
  getVoiceRecording(recordingId: string): Promise<Item<VoiceRecordingDetail>> {
    return this.request("GET", `/voice/recordings/${seg(recordingId)}`);
  }

  /** List voice insights for a project (scope: voice:read). */
  getVoiceInsights(projectId: string, options: PageOptions = {}): Promise<Page<VoiceInsight>> {
    return this.request("GET", `/projects/${seg(projectId)}/voice/insights`, { query: { limit: options.limit, cursor: options.cursor } });
  }

  // Pagination -------------------------------------------------------------

  /** Iterate every item of a paginated list method. */
  async *paginate<T>(fetchPage: (cursor: string | undefined) => Promise<Page<T>>): AsyncGenerator<T, void, undefined> {
    let cursor: string | undefined = undefined;
    for (;;) {
      const page: Page<T> = await fetchPage(cursor);
      for (const item of page.data) yield item;
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received. */
  payload: string;
  /** `x-beacon-signature` header (`sha256=<hex>`). */
  signature: string | null | undefined;
  /** `x-beacon-timestamp` header (Unix seconds). */
  timestamp: string | null | undefined;
  /** The webhook's signing secret (`whsec_…`). */
  secret: string;
  /** Reject deliveries older than this many seconds (default 300). */
  toleranceSeconds?: number;
  /** Override "now" (Unix seconds), for tests. */
  now?: number;
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Beacon webhook delivery: HMAC-SHA256 over `"<timestamp>.<body>"` with
 * the signing secret, compared in constant time, and a timestamp tolerance to
 * reject replays. Uses Web Crypto, so it works in Node 18+, Deno, Bun and edge runtimes.
 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<boolean> {
  const { payload, signature, timestamp, secret } = options;
  if (!signature || !timestamp || !secret || !/^\d{1,12}$/.test(timestamp)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (options.toleranceSeconds ?? 300)) return false;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is not available in this runtime");
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`));
  return constantTimeEqual(`sha256=${hex(mac)}`, signature.trim());
}
