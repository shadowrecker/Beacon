/**
 * tRPC request context.
 *
 * Resolves the Clerk session to a Beacon user (provisioning on the very first
 * request if the Clerk webhook hasn't landed yet) and reads the requested active
 * organization from the `x-org-id` header. Membership in that org is verified by
 * the org middleware in trpc.ts, never trusted from the header alone.
 */
import { auth, clerkClient } from "@clerk/nextjs/server";
import { randomUUID } from "node:crypto";
import { prisma, type DbClient } from "@/lib/db";
import { upsertUserFromClerk } from "./auth/provision";

export interface ContextUser {
  id: string;
  clerkId: string;
  email: string | null;
  name: string | null;
}

export interface Context {
  prisma: DbClient;
  user: ContextUser | null;
  /** Org requested by the client; validated by orgProcedure. */
  requestedOrgId: string | null;
  requestId: string;
  ip: string | null;
}

async function resolveUser(clerkId: string): Promise<ContextUser> {
  const existing = await prisma.user.findUnique({
    where: { clerkId },
    select: { id: true, clerkId: true, email: true, name: true },
  });
  if (existing) return existing;

  const client = await clerkClient();
  const cu = await client.users.getUser(clerkId);
  const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses[0];
  const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || null;
  const { userId } = await upsertUserFromClerk({
    clerkId,
    email: primary?.emailAddress?.toLowerCase() ?? null,
    name,
    avatarUrl: cu.imageUrl ?? null,
  });
  return { id: userId, clerkId, email: primary?.emailAddress?.toLowerCase() ?? null, name };
}

export async function createContext(req?: Request): Promise<Context> {
  const { userId: clerkId } = await auth();
  const user = clerkId ? await resolveUser(clerkId) : null;
  const headerOrg = req?.headers.get("x-org-id") ?? null;
  return {
    prisma,
    user,
    requestedOrgId: headerOrg && /^[a-z0-9]{10,40}$/i.test(headerOrg) ? headerOrg : null,
    requestId: req?.headers.get("x-request-id") ?? randomUUID(),
    ip: req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}

/** Context for tests and server-side callers. */
export function createTestContext(overrides: Partial<Context> = {}): Context {
  return {
    prisma,
    user: null,
    requestedOrgId: null,
    requestId: "test",
    ip: null,
    ...overrides,
  };
}
