/**
 * Shared helpers for the ingestion-source tests (integrations, marketplace,
 * competitive, voice).
 */
import type { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SafeFetchOptions, SafeFetchResponse } from "@/lib/safe-fetch";
import { createTestContext } from "@/server/context";
import { runJob, type WorkerDefinition } from "@/server/jobs/worker";
import type { QueueName } from "@/server/jobs/queues";
import { createCallerFactory, router } from "@/server/trpc";
import { integrationRouter } from "@/server/routers/integration";
import { marketplaceRouter } from "@/server/routers/marketplace";
import { competitiveRouter } from "@/server/routers/competitive";
import { voiceRouter } from "@/server/routers/voice";
import { jobRouter } from "@/server/routers/job";
import { encryptCredentials, type Credentials } from "@/server/integrations/credentials";
import { setIntegrationTransportForTests } from "@/server/integrations/http";
import type { TestUser } from "../helpers/factories";

const sourcesRouter = router({
  integration: integrationRouter,
  marketplace: marketplaceRouter,
  competitive: competitiveRouter,
  voice: voiceRouter,
  job: jobRouter,
});
const createCaller = createCallerFactory(sourcesRouter);

/** A caller over just the sources routers, authenticated as `user`, acting in `orgId`. */
export function callerFor(user: TestUser | null, orgId?: string) {
  return createCaller(
    createTestContext({
      user: user ? { id: user.id, clerkId: user.clerkId, email: user.email, name: user.name } : null,
      requestedOrgId: orgId ?? null,
    })
  );
}

export async function runWorker<Q extends QueueName>(def: WorkerDefinition<Q>, payload: unknown, attempt = 1, maxAttempts = 3) {
  return runJob(def, payload, { jobId: `test_${Date.now()}`, attempt, maxAttempts });
}

// ---------------------------------------------------------------------------
// Fake HTTP
// ---------------------------------------------------------------------------

export function fakeResponse(status: number, body: unknown, headers: Record<string, string> = {}, url = "https://fake.test/"): SafeFetchResponse {
  const isText = typeof body === "string";
  const buf = Buffer.from(isText ? (body as string) : body === undefined ? "" : JSON.stringify(body), "utf8");
  const h = new Headers({ "content-type": isText ? "text/html; charset=utf-8" : "application/json", ...headers });
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: h,
    url,
    body: buf,
    text: () => buf.toString("utf8"),
    json: <T,>() => JSON.parse(buf.toString("utf8")) as T,
  };
}

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type FakeHandler = (call: RecordedCall) => SafeFetchResponse | Promise<SafeFetchResponse>;

/** Route every integration HTTP request to `handler`; returns the recorded calls. */
export function installTransport(handler: FakeHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  setIntegrationTransportForTests(async (url: string, opts: SafeFetchOptions) => {
    const call: RecordedCall = {
      url: new URL(url),
      method: opts.method ?? "GET",
      headers: Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof opts.body === "string" ? opts.body : opts.body ? Buffer.from(opts.body).toString("utf8") : undefined,
    };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

export function unexpected(call: RecordedCall): never {
  throw new Error(`Unexpected request in test: ${call.method} ${call.url.toString()}`);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export async function createConnectedIntegration(input: {
  orgId: string;
  userId: string;
  projectId: string | null;
  provider: IntegrationProvider;
  credentials: Credentials;
  config?: Record<string, unknown>;
}) {
  return prisma.integration.create({
    data: {
      orgId: input.orgId,
      userId: input.userId,
      projectId: input.projectId,
      provider: input.provider,
      status: "CONNECTED",
      config: (input.config ?? {}) as object,
      ...encryptCredentials(input.credentials),
    },
  });
}

export async function newSync(integrationId: string) {
  return prisma.integrationSync.create({ data: { integrationId, status: "PENDING" } });
}

export const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return this;
  },
} as unknown as import("@/lib/logger").Logger;
