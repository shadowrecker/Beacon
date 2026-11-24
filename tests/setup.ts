/**
 * Global test setup.
 *
 * Integration tests run against a real Postgres (with pgvector) and Redis:
 * TEST_DATABASE_URL (default: local dev Postgres on 5433, database beacon_test)
 * and TEST_REDIS_URL (default: local Redis on 6380, db 1). The schema is applied
 * with `prisma migrate deploy` once per run; tables are truncated before each test.
 *
 * External services are replaced: LLM and embeddings by fakes, storage by an
 * in-memory driver, and job enqueueing by a capture transport.
 */
import { afterAll, beforeAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";

(process.env as Record<string, string>).NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://beacon@localhost:5433/beacon_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380/1";
process.env.CLERK_SECRET_KEY ??= "sk_test_dummy";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??= "pk_test_dummy";
process.env.STORAGE_DRIVER = "s3";
process.env.S3_BUCKET = "test-bucket";
process.env.APP_URL = "http://localhost:3000";
process.env.CREDENTIALS_ENCRYPTION_KEYS = JSON.stringify({ 1: Buffer.alloc(32, 7).toString("base64") });
process.env.CREDENTIALS_KEY_VERSION = "1";

let migrated = false;

beforeAll(async () => {
  if (!migrated) {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: "ignore",
    });
    migrated = true;
  }
  const { installTestDoubles } = await import("./helpers/doubles");
  installTestDoubles();
});

beforeEach(async () => {
  const { resetDatabase } = await import("./helpers/db");
  await resetDatabase();
  const { resetTestDoubles } = await import("./helpers/doubles");
  resetTestDoubles();
});

afterAll(async () => {
  const { prisma } = await import("@/lib/db");
  await prisma.$disconnect();
  const { closeRedis } = await import("@/lib/redis");
  await closeRedis();
});
