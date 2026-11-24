/**
 * Public surface: no sign-in needed. Covers the auth gates, platform endpoints,
 * security headers, service-worker rules and accessibility of public pages.
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Rendering pages needs a reachable Clerk instance: with development keys, Clerk
// performs a handshake redirect to the instance on a visitor's first request.
const clerkInstance = process.env.E2E_CLERK_INSTANCE === "1";

test.describe("public pages", () => {
  test("landing page renders with sign-in/up entry points and no serious a11y violations", async ({ page }) => {
    test.skip(!clerkInstance, "Needs a real Clerk development instance (set E2E_CLERK_INSTANCE=1 with its keys)");
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in/i }).first()).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test("protected pages redirect signed-out users to sign-in", async ({ page }) => {
    for (const path of ["/projects", "/team", "/settings", "/developer", "/m/record"]) {
      const res = await page.goto(path);
      expect(res?.url() ?? page.url(), path).toMatch(/sign-in|accounts\.dev|clerk/);
    }
  });
});

test.describe("platform endpoints", () => {
  test("liveness and readiness probes", async ({ request }) => {
    const live = await request.get("/api/health/live");
    expect(live.status()).toBe(200);
    const ready = await request.get("/api/health");
    expect([200, 503]).toContain(ready.status());
    const body = await ready.json();
    expect(body).toHaveProperty("checks");
    // Generic output only: no error details to unauthenticated callers.
    expect(JSON.stringify(body)).not.toMatch(/Error|prisma|ECONN/i);
  });

  test("security headers are set on every response", async ({ request }) => {
    const res = await request.get("/");
    const h = res.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["content-security-policy"]).toContain("object-src 'none'");
    expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["x-powered-by"]).toBeUndefined();
  });

  test("tRPC rejects unauthenticated calls", async ({ request }) => {
    const res = await request.get("/api/trpc/project.list");
    expect([401, 404]).toContain(res.status());
  });

  test("REST v1 requires an API key and serves the OpenAPI document", async ({ request }) => {
    const unauth = await request.get("/api/v1/projects");
    expect(unauth.status()).toBe(401);
    const bogus = await request.get("/api/v1/projects", { headers: { authorization: "Bearer bk_live_not-a-real-key" } });
    expect(bogus.status()).toBe(401);
    const spec = await request.get("/api/v1/openapi.json");
    expect(spec.status()).toBe(200);
    const doc = await spec.json();
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(5);
  });

  test("the image optimizer is not an open proxy", async ({ request }) => {
    const res = await request.get("/_next/image?url=https%3A%2F%2Fexample.com%2Fx.png&w=64&q=75");
    expect(res.status()).not.toBe(200);
  });
});

test.describe("PWA", () => {
  test("manifest icons exist and the service worker never caches API responses", async ({ request }) => {
    const manifest = await (await request.get("/manifest.json")).json();
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect((await request.get(icon.src)).status(), icon.src).toBe(200);
    }
    const sw = await (await request.get("/sw.js")).text();
    expect(sw).toMatch(/\/api\//);
    expect(sw).toMatch(/CLEAR_CACHES/);
  });
});
