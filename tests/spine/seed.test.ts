import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { assertSeedAllowed, DEMO_ORG_SLUG } from "../../scripts/seed";

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");

describe("seed script", () => {
  it("refuses production and non-local databases", () => {
    expect(() => assertSeedAllowed({ NODE_ENV: "production", DATABASE_URL: "postgresql://u@localhost:5432/db" })).toThrow(/production/);
    expect(() => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: "postgresql://u@db.prod.internal:5432/db" })).toThrow(/not local/);
    expect(() => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: "postgresql://u@10.0.0.5/db" })).toThrow(/not local/);
    expect(() => assertSeedAllowed({ NODE_ENV: "development" })).toThrow(/DATABASE_URL/);
    expect(() => assertSeedAllowed({ NODE_ENV: "development", DATABASE_URL: "postgresql://u@localhost:5433/beacon" })).not.toThrow();
    expect(() => assertSeedAllowed({ NODE_ENV: "test", DATABASE_URL: "postgresql://u@127.0.0.1/beacon" })).not.toThrow();
  });

  it("exits non-zero without touching the database when NODE_ENV=production", async () => {
    const err = await run("npx", ["tsx", "scripts/seed.ts"], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "postgresql://beacon@localhost:5433/does_not_exist" },
      timeout: 60_000,
    }).catch((e: { code?: number; stderr?: string }) => e);
    expect((err as { code?: number }).code).toBe(1);
    expect((err as { stderr?: string }).stderr).toContain("Refusing to seed: NODE_ENV is production.");
  }, 90_000);

  it("seeds a local database once (idempotent without --reset)", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };
    try {
      const first = await run("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, env, timeout: 90_000 });
      expect(first.stdout).toContain("Seed complete");
      const org = await prisma.organization.findUniqueOrThrow({
        where: { slug: DEMO_ORG_SLUG },
        include: { projects: { include: { _count: { select: { documents: true } } } } },
      });
      expect(org.projects.map((p) => p._count.documents).sort()).toEqual([2, 5]);
      const second = await run("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, env, timeout: 90_000 });
      expect(second.stdout).toContain("already exists");
      expect(await prisma.project.count({ where: { orgId: org.id } })).toBe(2);
    } finally {
      // The seed enqueued real processing jobs; drop them from this test Redis database.
      const redis = getRedis();
      const keys = await redis.keys("bull:*");
      if (keys.length > 0) await redis.del(...keys);
    }
  }, 200_000);
});
