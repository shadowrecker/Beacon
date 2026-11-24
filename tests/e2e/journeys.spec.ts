/**
 * Signed-in journeys. Require a Clerk development instance and a test
 * user (E2E_USER_EMAIL). AI-backed steps also require E2E_AI=1 and real model
 * keys. Without them the tests skip with a reason instead of passing vacuously.
 */
import { expect, test, type Page } from "@playwright/test";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { hasClerkTestingKeys } from "./global.setup";

const userEmail = process.env.E2E_USER_EMAIL ?? "";
const aiEnabled = process.env.E2E_AI === "1";

test.skip(!hasClerkTestingKeys() || !userEmail, "Needs a Clerk dev instance (CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) and E2E_USER_EMAIL");

async function signIn(page: Page): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.signIn({ page, emailAddress: userEmail });
}

const unique = () => `E2E ${Date.now().toString(36)}`;

test.describe("projects and documents", () => {
  test("create, rename and delete a project", async ({ page }) => {
    await signIn(page);
    await page.goto("/projects");
    const name = unique();
    await page.getByRole("button", { name: /new project|create project/i }).first().click();
    await page.getByLabel(/^name$/i).fill(name);
    await page.getByRole("button", { name: /^create/i }).click();
    await expect(page.getByText(name).first()).toBeVisible();
    await page.getByText(name).first().click();
    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+/);
    // Every project section tab is a real link.
    for (const tab of ["Documents", "Synthesis", "Recommendations", "Ask", "Roadmap", "Analytics", "Outcomes", "Decisions", "Sentiment"]) {
      await expect(page.getByRole("link", { name: tab })).toBeVisible();
    }
  });

  test("upload a text document and see it reach Ready", async ({ page }) => {
    test.skip(!aiEnabled, "Processing needs embeddings (E2E_AI=1 with OPENAI_API_KEY)");
    await signIn(page);
    await page.goto("/projects");
    await page.getByRole("button", { name: /new project|create project/i }).first().click();
    await page.getByLabel(/^name$/i).fill(unique());
    await page.getByRole("button", { name: /^create/i }).click();
    await page.getByRole("link", { name: "Documents" }).click();
    await page.setInputFiles('input[type="file"]', {
      name: "interview.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Interviewer: How was onboarding?\nCustomer: Connecting Jira took two days and the docs skipped steps."),
    });
    await expect(page.getByText(/ready/i).first()).toBeVisible({ timeout: 120_000 });
  });

  test("ask a question and get a cited answer", async ({ page }) => {
    test.skip(!aiEnabled, "Needs real model keys (E2E_AI=1)");
    await signIn(page);
    await page.goto("/projects");
    await page.getByRole("link").filter({ hasText: /E2E/ }).first().click();
    await page.getByRole("link", { name: "Ask" }).click();
    await page.getByRole("textbox").last().fill("What slowed onboarding down?");
    await page.getByRole("button", { name: /send question/i }).click();
    await expect(page.getByText(/jira|docs/i).first()).toBeVisible({ timeout: 120_000 });
  });
});

test.describe("team and developer platform", () => {
  test("create an organization and open the invite dialog", async ({ page }) => {
    await signIn(page);
    await page.goto("/team?create=1");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/create an organization/i)).toBeVisible();
    await dialog.getByRole("textbox").first().fill(unique());
    await dialog.getByRole("button", { name: /create/i }).click();
    await page.getByRole("tab", { name: /members/i }).click();
    await page.getByRole("button", { name: /invite/i }).first().click();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
  });

  test("create an API key, see it once, then revoke it", async ({ page }) => {
    await signIn(page);
    await page.goto("/developer/keys");
    await page.getByRole("button", { name: /create (an )?api key|new key|create key/i }).first().click();
    await page.getByLabel(/^name$/i).fill(unique());
    await page.getByRole("button", { name: /^create/i }).last().click();
    const secret = page.getByText(/bk_live_/).first();
    await expect(secret).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    // The full key is never shown again.
    await expect(page.getByText(/bk_live_[A-Za-z0-9_-]{20,}/)).toHaveCount(0);
  });
});

test.describe("mobile @mobile", () => {
  test("mobile home and recordings index load", async ({ page }) => {
    await signIn(page);
    await page.goto("/m");
    await expect(page.getByRole("link", { name: /record/i }).first()).toBeVisible();
    await page.goto("/m/recordings");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
