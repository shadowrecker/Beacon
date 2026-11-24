import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sweepStuckJobs, applyRetention, STUCK_AFTER_MS } from "@/server/jobs/maintenance";
import { dispatchEvent } from "@/server/events/dispatcher";
import type { Subscriber } from "@/server/events/types";
import { createProject, createUser } from "../helpers/factories";

describe("sweepStuckJobs", () => {
  it("fails rows stuck past their deadline and leaves fresh ones alone", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const stale = await prisma.document.create({
      data: { projectId: project.id, title: "stale", type: "NOTE", status: "PROCESSING" },
    });
    const fresh = await prisma.document.create({
      data: { projectId: project.id, title: "fresh", type: "NOTE", status: "PROCESSING" },
    });
    await prisma.$executeRaw`UPDATE documents SET "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '2 hours' WHERE id = ${stale.id}`;

    const result = await sweepStuckJobs();
    expect(result.documents).toBe(1);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("FAILED");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("PROCESSING");
    expect(STUCK_AFTER_MS.document).toBeLessThan(2 * 3600_000);
  });

  it("deletes unconfirmed uploads after 24h instead of marking them failed", async () => {
    const { cleanupAbandonedUploads } = await import("@/server/jobs/maintenance");
    const { storage } = await import("../helpers/doubles");
    const user = await createUser();
    const project = await createProject(user);
    const abandoned = await prisma.document.create({
      data: {
        projectId: project.id,
        title: "never uploaded",
        type: "NOTE",
        status: "PENDING",
        storageKey: `projects/${project.id}/documents/x/f.txt`,
        metadata: { awaitingUpload: true },
      },
    });
    const recent = await prisma.document.create({
      data: { projectId: project.id, title: "in progress", type: "NOTE", status: "PENDING", metadata: { awaitingUpload: true } },
    });
    await storage.put(abandoned.storageKey!, Buffer.from("partial"), "text/plain");
    await prisma.$executeRaw`UPDATE documents SET "createdAt" = (now() AT TIME ZONE 'UTC') - interval '25 hours', "updatedAt" = (now() AT TIME ZONE 'UTC') - interval '25 hours' WHERE id = ${abandoned.id}`;

    // The stuck-job sweep leaves awaiting uploads alone...
    await sweepStuckJobs();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: abandoned.id } })).status).toBe("PENDING");
    // ...and the cleanup removes the old one (row + object) but not the recent one.
    expect(await cleanupAbandonedUploads()).toBe(1);
    expect(await prisma.document.findUnique({ where: { id: abandoned.id } })).toBeNull();
    expect(await storage.head(abandoned.storageKey!)).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it("applies retention to read notifications only", async () => {
    const user = await createUser();
    const old = await prisma.notification.create({ data: { userId: user.id, type: "SYSTEM", title: "t", message: "m", isRead: true } });
    const unread = await prisma.notification.create({ data: { userId: user.id, type: "SYSTEM", title: "t", message: "m" } });
    await prisma.$executeRaw`UPDATE notifications SET "createdAt" = (now() AT TIME ZONE 'UTC') - interval '400 days'`;
    const res = await applyRetention();
    expect(res.notifications).toBe(1);
    expect(await prisma.notification.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.notification.findUnique({ where: { id: unread.id } })).not.toBeNull();
  });
});

describe("dispatchEvent", () => {
  it("skips subscribers that already succeeded when retrying", async () => {
    const user = await createUser();
    const event = await prisma.domainEvent.create({
      data: { orgId: user.personalOrgId, type: "document.ready", payload: { documentId: "d", title: "t", chunkCount: 1 } },
    });
    const okHandle = vi.fn(async () => undefined);
    let fail = true;
    const flakyHandle = vi.fn(async () => {
      if (fail) throw new Error("boom");
    });
    const subs: Subscriber[] = [
      { name: `ok-${event.id}`, handles: () => true, handle: okHandle },
      { name: `flaky-${event.id}`, handles: () => true, handle: flakyHandle },
      { name: `ignores-${event.id}`, handles: (t) => t === "other", handle: vi.fn() },
    ];

    await expect(dispatchEvent(event.id, logger, subs)).rejects.toThrow(/flaky/);
    expect((await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } })).dispatchedAt).toBeNull();

    fail = false;
    await dispatchEvent(event.id, logger, subs);
    expect(okHandle).toHaveBeenCalledTimes(1); // not re-run on retry
    expect(flakyHandle).toHaveBeenCalledTimes(2);
    expect(subs[2].handle).not.toHaveBeenCalled();
    expect((await prisma.domainEvent.findUniqueOrThrow({ where: { id: event.id } })).dispatchedAt).not.toBeNull();
  });
});
