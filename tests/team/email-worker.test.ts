import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { getRedis } from "@/lib/redis";
import { runJob } from "@/server/jobs/worker";
import { emailWorker, sentKey } from "@/workers/email-worker";
import { escapeHtml, renderEmail } from "@/server/email/templates";
import { RESEND_ENDPOINT } from "@/server/email/resend";

const APP = "http://localhost:3000";
const meta = (attempt = 1) => ({ jobId: "job-1", attempt, maxAttempts: 5 });
let seq = 0;
const key = () => `test-email-${Date.now()}-${seq++}`;

const XSS = `<script>alert("x")</script><img src=x onerror=alert(1)>`;

describe("email templates", () => {
  it("escapes every interpolated value and includes text and preference links", () => {
    const invite = renderEmail(
      "org-invite",
      {
        orgName: `Evil ${XSS}`,
        inviterName: `Mallory "&" <b>`,
        role: "MEMBER",
        acceptUrl: `${APP}/invite/abcDEF123_-`,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      },
      APP
    );
    expect(invite.html).not.toContain("<script>");
    expect(invite.html).not.toContain("<img src=x");
    expect(invite.html).not.toContain("<b>");
    expect(invite.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(invite.html).toContain("Mallory &quot;&amp;&quot; &lt;b&gt;");
    expect(invite.html).toContain(`href="${APP}/invite/abcDEF123_-"`);
    expect(invite.html).toContain(`${APP}/settings#notifications`);
    expect(invite.text).toContain(`${APP}/invite/abcDEF123_-`);
    expect(invite.text).toContain(`${APP}/settings#notifications`);
    expect(invite.subject).not.toMatch(/[\r\n]/);

    const note = renderEmail("notification", { title: `Hi\r\nBcc: x@y.z ${XSS}`, message: `Line 1\n\n${XSS}`, href: "/projects/p1" }, APP);
    expect(note.subject).not.toMatch(/[\r\n]/);
    expect(note.html).not.toContain("<script>");
    expect(note.html).toContain(`${APP}/projects/p1`);
    expect(note.text).toContain(XSS); // plain text is not HTML; it carries the raw words
    expect(escapeHtml(`'\``)).toBe("&#39;&#96;");
  });

  it("drops links that point anywhere but this app", () => {
    const note = renderEmail("mention", { title: "t", message: "m", href: "https://evil.example/phish" }, APP);
    expect(note.html).not.toContain("evil.example");
    const proto = renderEmail("mention", { title: "t", message: "m", href: "javascript:alert(1)" }, APP);
    expect(proto.html).not.toContain("javascript:");
    const schemeRelative = renderEmail("mention", { title: "t", message: "m", href: "//evil.example/x" }, APP);
    expect(schemeRelative.html).not.toContain("evil.example");
    expect(() =>
      renderEmail(
        "org-invite",
        { orgName: "o", inviterName: "i", role: "MEMBER", acceptUrl: "https://evil.example/invite/x", expiresAt: new Date().toISOString() },
        APP
      )
    ).toThrow(/this app/);
  });
});

describe("email worker", () => {
  const saved = { RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM, NODE_ENV: process.env.NODE_ENV };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string>)[k] = v;
    }
  });

  const job = (dedupeKey: string) => ({
    to: "someone@example.test",
    template: "notification" as const,
    data: { title: `Synthesis complete ${XSS}`, message: "Found 3 themes.", href: "/projects/p1/synthesis" },
    dedupeKey,
  });

  it("is a logged no-op without RESEND_API_KEY outside production", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(runJob(emailWorker, job(key()), meta())).resolves.toMatchObject({ sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails permanently without RESEND_API_KEY in production", async () => {
    delete process.env.RESEND_API_KEY;
    (process.env as Record<string, string>).NODE_ENV = "production";
    await expect(runJob(emailWorker, job(key()), meta())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends escaped HTML with a text part through Resend, once per dedupe key", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "Beacon <notify@beacon.test>";
    const dk = key();
    await expect(runJob(emailWorker, job(dk), meta())).resolves.toMatchObject({ sent: true, providerId: "re_123" });
    await expect(runJob(emailWorker, job(dk), meta())).resolves.toMatchObject({ skipped: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Idempotency-Key"]).toMatch(/^[a-f0-9]{64}$/);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: "Beacon <notify@beacon.test>", to: ["someone@example.test"] });
    expect(body.html).not.toContain("<script>");
    expect(body.html).toContain("&lt;script&gt;");
    expect(body.text).toContain("Found 3 themes.");
    expect(body.headers["List-Unsubscribe"]).toBe(`<${APP}/settings#notifications>`);
    await getRedis().del(sentKey(dk));
  });

  it("treats provider 4xx as permanent and 5xx/429 as retryable", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: "validation_error" }), { status: 422 }));
    await expect(runJob(emailWorker, job(key()), meta())).rejects.toBeInstanceOf(UnrecoverableError);

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const err = await runJob(emailWorker, job(key()), meta()).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err).toMatchObject({ status: 503 });

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    expect(await runJob(emailWorker, job(key()), meta()).catch((e: unknown) => e)).not.toBeInstanceOf(UnrecoverableError);
  });

  it("rejects invalid template data permanently", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const bad = { ...job(key()), template: "org-invite" as const, data: { orgName: "x" } };
    await expect(runJob(emailWorker, bad, meta())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
