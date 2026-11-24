/**
 * The single Prisma client for the process (web server and workers alike).
 *
 * Never construct another PrismaClient: each one opens its own connection pool.
 * Query logging is off even in development because queries carry user content.
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/** Alias kept for existing call sites. */
export const db = prisma;

export type Db = PrismaClient;
/** A Prisma client or interactive-transaction client. */
export type DbClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export default prisma;
