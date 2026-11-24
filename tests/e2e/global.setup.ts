import { clerkSetup } from "@clerk/testing/playwright";

/** Fetch a Clerk testing token when a real Clerk dev instance is configured. */
export default async function globalSetup(): Promise<void> {
  if (hasClerkTestingKeys()) await clerkSetup();
}

/**
 * Signed-in journeys are opt-in: they need a real Clerk development instance and
 * a test user, declared with E2E_USER_EMAIL.
 */
export function hasClerkTestingKeys(): boolean {
  const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  const sk = process.env.CLERK_SECRET_KEY ?? "";
  return (
    Boolean(process.env.E2E_USER_EMAIL) &&
    pk.startsWith("pk_test_") &&
    sk.startsWith("sk_test_") &&
    !pk.includes("REPLACE") &&
    !sk.includes("REPLACE")
  );
}
