import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { UnrecoverableError } from "bullmq";
import { prisma } from "@/lib/db";
import { enqueue, PAYLOADS, QUEUE } from "@/server/jobs/queues";
import { defineWorker, NonRetryableError, runJob } from "@/server/jobs/worker";
import { emitEvent } from "@/server/events/bus";
import { generateObject, registerCustomizationHook } from "@/server/ai/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRedis } from "@/lib/redis";
import { jobs, jobsFor, llmCalls, scriptLLM } from "../helpers/doubles";
import { createUser } from "../helpers/factories";

describe("queue registry", () => {
  it("defines a payload schema for every queue", () => {
    for (const name of Object.values(QUEUE)) expect(PAYLOADS[name]).toBeDefined();
  });

  it("validates payloads at enqueue and dedupes by jobId", async () => {
    await expect(enqueue(QUEUE.DOCUMENTS, { documentId: "" } as never)).rejects.toThrow();
    await enqueue(QUEUE.DOCUMENTS, { documentId: "doc1" }, { jobId: "doc_doc1" });
    await enqueue(QUEUE.DOCUMENTS, { documentId: "doc1" }, { jobId: "doc_doc1" });
    expect(jobsFor(QUEUE.DOCUMENTS)).toHaveLength(1);
  });
});

describe("runJob", () => {
  const meta = (attempt: number, max = 3) => ({ jobId: "j1", attempt, maxAttempts: max });

  it("rejects invalid payloads as unrecoverable", async () => {
    const def = defineWorker({ queue: QUEUE.DOCUMENTS, handler: async () => "ok" });
    await expect(runJob(def, { nope: 1 }, meta(1))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("marks the row failed immediately for non-retryable errors", async () => {
    const onFinalFailure = vi.fn(async () => undefined);
    const def = defineWorker({
      queue: QUEUE.DOCUMENTS,
      handler: async () => {
        throw new NonRetryableError("bad input");
      },
      onFinalFailure,
    });
    await expect(runJob(def, { documentId: "d" }, meta(1))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(onFinalFailure).toHaveBeenCalledTimes(1);
  });

  it("only marks failed on the last attempt for retryable errors", async () => {
    const onFinalFailure = vi.fn(async () => undefined);
    const def = defineWorker({
      queue: QUEUE.DOCUMENTS,
      handler: async () => {
        throw new Error("transient");
      },
      onFinalFailure,
    });
    await expect(runJob(def, { documentId: "d" }, meta(1))).rejects.toThrow("transient");
    await expect(runJob(def, { documentId: "d" }, meta(2))).rejects.toThrow("transient");
    expect(onFinalFailure).not.toHaveBeenCalled();
    await expect(runJob(def, { documentId: "d" }, meta(3))).rejects.toThrow("transient");
    expect(onFinalFailure).toHaveBeenCalledTimes(1);
  });

  it("treats upstream 4xx (except 408/409/429) as non-retryable", async () => {
    const onFinalFailure = vi.fn(async () => undefined);
    const err400 = Object.assign(new Error("bad request"), { status: 400 });
    const def = defineWorker({ queue: QUEUE.DOCUMENTS, handler: async () => { throw err400; }, onFinalFailure });
    await expect(runJob(def, { documentId: "d" }, meta(1))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(onFinalFailure).toHaveBeenCalledTimes(1);
  });
});

describe("domain events", () => {
  it("writes an outbox row and enqueues fan-out", async () => {
    const user = await createUser();
    const id = await emitEvent({
      orgId: user.personalOrgId,
      type: "document.ready",
      payload: { documentId: "d1", title: "T", chunkCount: 3 },
      actorUserId: user.id,
    });
    const row = await prisma.domainEvent.findUniqueOrThrow({ where: { id } });
    expect(row.type).toBe("document.ready");
    expect(jobsFor(QUEUE.DOMAIN_EVENTS)).toEqual([expect.objectContaining({ payload: { eventId: id } })]);
  });

  it("rejects payloads that don't match the catalog", async () => {
    const user = await createUser();
    await expect(
      emitEvent({ orgId: user.personalOrgId, type: "document.ready", payload: { documentId: "d1" } as never })
    ).rejects.toThrow();
    expect(jobs).toHaveLength(0);
  });
});

describe("LLM client", () => {
  it("validates output, records usage and applies org customization", async () => {
    const user = await createUser();
    registerCustomizationHook(async (orgId) => (orgId === user.personalOrgId ? "Organization context: use the word 'widget'." : null));
    scriptLLM("test.feature", () => ({ answer: 42 }));
    const out = await generateObject({
      feature: "test.feature",
      orgId: user.personalOrgId,
      system: "base system",
      prompt: "q",
      schema: z.object({ answer: z.number() }),
    });
    expect(out).toEqual({ answer: 42 });
    expect(llmCalls[0].system).toContain("base system");
    expect(llmCalls[0].system).toContain("widget");
    const usage = await prisma.tokenUsage.findMany({ where: { orgId: user.personalOrgId } });
    expect(usage).toHaveLength(1);
    expect(usage[0].feature).toBe("test.feature");
    registerCustomizationHook(async () => null);
  });

  it("rejects schema-invalid model output", async () => {
    const user = await createUser();
    scriptLLM("test.invalid", () => ({ answer: "not a number" }));
    await expect(
      generateObject({ feature: "test.invalid", orgId: user.personalOrgId, system: "s", prompt: "p", schema: z.object({ answer: z.number() }) })
    ).rejects.toThrow();
  });
});

describe("rate limiter", () => {
  it("allows up to the limit and always sets a TTL", async () => {
    const rule = { name: `test-${Date.now()}`, limit: 3, windowMs: 10_000 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await checkRateLimit(rule, "u1")).allowed);
    expect(results).toEqual([true, true, true, false]);
    const ttl = await getRedis().pttl(`rl:${rule.name}:u1`);
    expect(ttl).toBeGreaterThan(0);
  });
});

describe("failureMessage", () => {
  it("never surfaces raw upstream error text", async () => {
    const { failureMessage } = await import("@/server/jobs/worker");
    const upstream = Object.assign(new Error("401 Incorrect API key provided: sk-REPLA*E_ME"), { status: 401 });
    expect(failureMessage(upstream)).toContain("HTTP 401");
    expect(failureMessage(upstream)).not.toContain("sk-");
    expect(failureMessage(Object.assign(new Error("upstream body"), { status: 503 }))).not.toContain("upstream body");
    expect(failureMessage(Object.assign(new Error("x"), { status: 429 }))).toContain("rate limiting");
  });
});
