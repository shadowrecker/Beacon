import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests.
 *
 * - tests/e2e/public.spec.ts runs anywhere: public pages, auth gates, health,
 *   security headers, REST/OpenAPI, service worker, accessibility.
 * - tests/e2e/journeys.spec.ts signs in through Clerk testing tokens and needs a
 *   Clerk development instance (CLERK_SECRET_KEY + NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
 *   and E2E_USER_EMAIL (a user in that instance). AI-backed steps additionally
 *   need E2E_AI=1 with real ANTHROPIC/OPENAI keys. Unset -> those tests skip.
 *
 * The app must be built first (`npm run build`); E2E_BASE_URL targets a
 * deployed environment (e.g. staging) instead of starting a local server.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3200";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./tests/e2e/global.setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 15"] }, grep: /@mobile/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npx next start -p 3200",
        url: `${baseURL}/api/health/live`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
