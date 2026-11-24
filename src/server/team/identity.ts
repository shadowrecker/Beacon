/**
 * Identity-provider operations (Clerk) used by team and account features.
 *
 * Everything that must be decided by the identity provider rather than by our
 * own database goes through here:
 * - which email addresses a user has *verified* (invite acceptance),
 * - deleting the sign-in account (GDPR erasure),
 * - keeping the display name in sync (the Clerk webhook would otherwise
 *   overwrite a name changed only in Beacon).
 *
 * Tests replace the provider with `setIdentityProviderForTests`.
 */
import { clerkClient } from "@clerk/nextjs/server";

export interface IdentityProvider {
  /** Lower-cased email addresses the user has verified. */
  getVerifiedEmails(clerkId: string): Promise<string[]>;
  /** Delete the user's sign-in account. Resolves when it no longer exists. */
  deleteUser(clerkId: string): Promise<void>;
  /** Set the user's display name. */
  updateName(clerkId: string, name: string): Promise<void>;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; statusCode?: number } | null;
  return e?.status ?? e?.statusCode;
}

/** Split "Mary Ann Smith" into first "Mary" / last "Ann Smith"; joined back with one space it round-trips. */
export function splitName(name: string): { firstName: string; lastName: string } {
  const normalized = name.trim().replace(/\s+/g, " ");
  const idx = normalized.indexOf(" ");
  if (idx === -1) return { firstName: normalized, lastName: "" };
  return { firstName: normalized.slice(0, idx), lastName: normalized.slice(idx + 1) };
}

const clerkIdentity: IdentityProvider = {
  async getVerifiedEmails(clerkId) {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkId);
    return user.emailAddresses
      .filter((e) => e.verification?.status === "verified")
      .map((e) => e.emailAddress.trim().toLowerCase());
  },
  async deleteUser(clerkId) {
    const client = await clerkClient();
    try {
      await client.users.deleteUser(clerkId);
    } catch (err) {
      // Already gone: erasure of the sign-in account is complete.
      if (statusOf(err) === 404) return;
      throw err;
    }
  },
  async updateName(clerkId, name) {
    const client = await clerkClient();
    await client.users.updateUser(clerkId, splitName(name));
  },
};

let provider: IdentityProvider = clerkIdentity;

export function getIdentityProvider(): IdentityProvider {
  return provider;
}

/** Replace the identity provider (tests). Pass null to restore Clerk. */
export function setIdentityProviderForTests(p: IdentityProvider | null): void {
  provider = p ?? clerkIdentity;
}
