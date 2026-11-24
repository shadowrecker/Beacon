/**
 * Helpers for the team tests.
 *
 * `teamCaller` mounts only the team routers, so these tests don't
 * depend on every other router in the app importing cleanly.
 */
import { beforeEach } from "vitest";
import { prisma } from "@/lib/db";
import { router, createCallerFactory } from "@/server/trpc";
import { createTestContext } from "@/server/context";
import { organizationRouter } from "@/server/routers/organization";
import { teamRouter } from "@/server/routers/team";
import { userRouter } from "@/server/routers/user";
import { collaborationRouter } from "@/server/routers/collaboration";
import { setIdentityProviderForTests } from "@/server/team/identity";
import { jobsFor } from "../helpers/doubles";
import type { TestUser } from "../helpers/factories";

const teamRouterUnderTest = router({
  organization: organizationRouter,
  team: teamRouter,
  user: userRouter,
  collaboration: collaborationRouter,
});
const createCaller = createCallerFactory(teamRouterUnderTest);

export function teamCaller(user: TestUser | null, orgId?: string) {
  return createCaller(
    createTestContext({
      user: user ? { id: user.id, clerkId: user.clerkId, email: user.email, name: user.name } : null,
      requestedOrgId: orgId ?? null,
    })
  );
}

/** Fake identity provider state, reset before each test. */
export const identity = {
  /** clerkId -> verified emails; defaults to the user's DB email when unset. */
  verified: new Map<string, string[]>(),
  deleted: [] as string[],
  renamed: [] as Array<{ clerkId: string; name: string }>,
  failDelete: false,
};

export function installFakeIdentity(): void {
  beforeEach(() => {
    identity.verified.clear();
    identity.deleted.length = 0;
    identity.renamed.length = 0;
    identity.failDelete = false;
    setIdentityProviderForTests({
      async getVerifiedEmails(clerkId) {
        const explicit = identity.verified.get(clerkId);
        if (explicit) return explicit;
        const u = await prisma.user.findUnique({ where: { clerkId }, select: { email: true } });
        return u?.email ? [u.email.toLowerCase()] : [];
      },
      async deleteUser(clerkId) {
        if (identity.failDelete) throw new Error("clerk unavailable");
        identity.deleted.push(clerkId);
      },
      async updateName(clerkId, name) {
        identity.renamed.push({ clerkId, name });
      },
    });
  });
}

/** The raw invite token from the most recent org-invite email job. */
export function lastInviteToken(): string {
  const jobs = jobsFor("email").filter((j) => (j.payload as { template: string }).template === "org-invite");
  const last = jobs[jobs.length - 1];
  if (!last) throw new Error("no invite email was enqueued");
  const url = (last.payload as { data: { acceptUrl: string } }).data.acceptUrl;
  return url.split("/invite/")[1];
}
