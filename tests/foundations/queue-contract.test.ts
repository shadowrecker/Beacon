/**
 * Queue contract: every queue has exactly one registered worker, and
 * every worker consumes a known queue. Producers can only enqueue to names in
 * QUEUE (enforced by types), so names can never drift apart again.
 */
import { describe, expect, it } from "vitest";
import { QUEUE } from "@/server/jobs/queues";
import { WORKERS } from "@/workers/registry";
import { MAINTENANCE_SCHEDULES } from "@/workers/maintenance-worker";
import { PAYLOADS } from "@/server/jobs/queues";

describe("queue contract", () => {
  it("registers exactly one worker per queue", () => {
    for (const name of Object.values(QUEUE)) {
      const consumers = WORKERS.filter((w) => w.queue === name);
      expect(consumers, `queue ${name}`).toHaveLength(1);
    }
    expect(WORKERS).toHaveLength(Object.values(QUEUE).length);
  });

  it("only schedules valid maintenance tasks", () => {
    for (const s of MAINTENANCE_SCHEDULES) {
      expect(PAYLOADS[QUEUE.MAINTENANCE].safeParse({ task: s.task }).success).toBe(true);
    }
  });
});
