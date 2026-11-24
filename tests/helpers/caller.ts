import { appRouter } from "@/server/root";
import { createTestContext } from "@/server/context";
import { createCallerFactory } from "@/server/trpc";
import type { TestUser } from "./factories";

const createCaller = createCallerFactory(appRouter);

/** A tRPC caller authenticated as `user`, optionally acting in `orgId`. */
export function callerFor(user: TestUser | null, orgId?: string) {
  return createCaller(
    createTestContext({
      user: user ? { id: user.id, clerkId: user.clerkId, email: user.email, name: user.name } : null,
      requestedOrgId: orgId ?? null,
    })
  );
}
