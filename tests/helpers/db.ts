import { prisma } from "@/lib/db";

let tables: string[] | null = null;

/** Truncate every application table (keeps the migrations table). */
export async function resetDatabase(): Promise<void> {
  if (!tables) {
    const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    tables = rows.map((r) => r.tablename);
  }
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
