import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/db";
import { BUILTIN_MARKETPLACE_CONNECTORS, ensureMarketplaceSeeded, resetMarketplaceSeedForTests } from "@/server/marketplace/registry";
import { parseMarkdown, safeHref, SafeMarkdown } from "@/components/marketplace/safe-markdown";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { callerFor, createConnectedIntegration } from "./helpers";

beforeEach(() => resetMarketplaceSeedForTests());

async function workspace() {
  const owner = await createUser();
  const org = await createOrg(owner);
  const project = await createProject(owner, org.id);
  return { owner, org, project };
}

describe("catalog seeding and browse", () => {
  it("seeds the 12 built-in connectors idempotently without resetting counters", async () => {
    await ensureMarketplaceSeeded();
    expect(await prisma.marketplaceConnector.count()).toBe(BUILTIN_MARKETPLACE_CONNECTORS.length);
    await prisma.marketplaceConnector.update({ where: { slug: "slack" }, data: { installCount: 7, ratingAverage: 4.5, ratingCount: 2 } });
    resetMarketplaceSeedForTests();
    await ensureMarketplaceSeeded();
    expect(await prisma.marketplaceConnector.count()).toBe(12);
    expect(await prisma.marketplaceConnector.findUniqueOrThrow({ where: { slug: "slack" } })).toMatchObject({ installCount: 7, ratingAverage: 4.5, ratingCount: 2 });
  });

  it("searches and filters by category with cursor pagination", async () => {
    const { owner, org } = await workspace();
    const caller = callerFor(owner, org.id);
    const all = await caller.marketplace.browse({ limit: 50 });
    expect(all.items).toHaveLength(12);
    const search = await caller.marketplace.browse({ search: "zend", limit: 50 });
    expect(search.items.map((c) => c.slug)).toEqual(["zendesk"]);
    const analytics = await caller.marketplace.browse({ category: "ANALYTICS", limit: 50 });
    expect(analytics.items.map((c) => c.slug).sort()).toEqual(["amplitude", "mixpanel"]);
    const page1 = await caller.marketplace.browse({ limit: 5 });
    const page2 = await caller.marketplace.browse({ limit: 5, cursor: page1.nextCursor! });
    expect(page1.items).toHaveLength(5);
    expect(page2.items).toHaveLength(5);
    expect(new Set([...page1.items, ...page2.items].map((c) => c.id)).size).toBe(10);
    expect((await caller.marketplace.getFeatured()).length).toBeGreaterThan(0);
  });
});

describe("install / uninstall", () => {
  it("installs once per org, links an existing integration, and uninstalls", async () => {
    const { owner, org, project } = await workspace();
    const caller = callerFor(owner, org.id);
    const first = await caller.marketplace.install({ slug: "linear", projectId: project.id });
    expect(first).toMatchObject({ created: true, next: { kind: "apiKey", provider: "LINEAR" } });
    const again = await caller.marketplace.install({ slug: "linear", projectId: project.id });
    expect(again.created).toBe(false);
    expect(await prisma.connectorInstall.count()).toBe(1);
    expect((await prisma.marketplaceConnector.findUniqueOrThrow({ where: { slug: "linear" } })).installCount).toBe(1);

    const slack = await createConnectedIntegration({ orgId: org.id, userId: owner.id, projectId: project.id, provider: "SLACK", credentials: { botToken: "x" } });
    const linked = await caller.marketplace.install({ slug: "slack", projectId: project.id });
    expect(linked.next.kind).toBe("connected");
    expect(await prisma.connectorInstall.findFirstOrThrow({ where: { connector: { slug: "slack" } } })).toMatchObject({ integrationId: slack.id, status: "ACTIVE" });

    const detail = await caller.marketplace.get({ slug: "linear" });
    expect(detail.install).not.toBeNull();
    expect((await caller.marketplace.listInstalled()).map((i) => i.connector.slug).sort()).toEqual(["linear", "slack"]);

    await caller.marketplace.uninstall({ slug: "linear", disconnect: true });
    expect((await prisma.marketplaceConnector.findUniqueOrThrow({ where: { slug: "linear" } })).installCount).toBe(0);
    await expect(caller.marketplace.uninstall({ slug: "linear", disconnect: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires integrations:manage; outsiders can't act in the org", async () => {
    const { org, project } = await workspace();
    const member = await createUser();
    const viewer = await createUser();
    const outsider = await createUser();
    await addMember(org.id, member, "MEMBER");
    await addMember(org.id, viewer, "VIEWER");
    for (const u of [member, viewer]) {
      await expect(callerFor(u, org.id).marketplace.install({ slug: "linear", projectId: project.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(callerFor(outsider, org.id).marketplace.browse({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    // An outsider admin of their own org can't install into someone else's project.
    await expect(callerFor(outsider).marketplace.install({ slug: "linear", projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reviews and helpful votes", () => {
  it("keeps one review per user and recomputes the rating aggregate", async () => {
    const { owner, org, project } = await workspace();
    const member = await createUser();
    await addMember(org.id, member, "MEMBER");
    const ownerCaller = callerFor(owner, org.id);
    await expect(ownerCaller.marketplace.addReview({ slug: "notion", rating: 5 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await ownerCaller.marketplace.install({ slug: "notion", projectId: project.id });

    await ownerCaller.marketplace.addReview({ slug: "notion", rating: 5, title: "Great" });
    await ownerCaller.marketplace.addReview({ slug: "notion", rating: 1, title: "Changed my mind" });
    await ownerCaller.marketplace.addReview({ slug: "notion", rating: 2 });
    const memberCaller = callerFor(member, org.id);
    const res = await memberCaller.marketplace.addReview({ slug: "notion", rating: 4, content: "Solid" });
    expect(res).toMatchObject({ ratingAverage: 3, ratingCount: 2 });
    expect(await prisma.connectorReview.count()).toBe(2);
    expect(await prisma.marketplaceConnector.findUniqueOrThrow({ where: { slug: "notion" } })).toMatchObject({ ratingAverage: 3, ratingCount: 2 });

    const reviews = await ownerCaller.marketplace.getReviews({ slug: "notion" });
    expect(reviews.items).toHaveLength(2);
    expect(JSON.stringify(reviews)).not.toContain(member.email);

    await memberCaller.marketplace.deleteReview({ slug: "notion" });
    expect(await prisma.marketplaceConnector.findUniqueOrThrow({ where: { slug: "notion" } })).toMatchObject({ ratingAverage: 2, ratingCount: 1 });
  });

  it("counts one helpful vote per user and forbids voting on your own review", async () => {
    const { owner, org, project } = await workspace();
    const a = await createUser();
    const b = await createUser();
    await addMember(org.id, a, "MEMBER");
    await addMember(org.id, b, "MEMBER");
    await callerFor(owner, org.id).marketplace.install({ slug: "jira", projectId: project.id });
    const { reviewId } = await callerFor(owner, org.id).marketplace.addReview({ slug: "jira", rating: 4 });

    await expect(callerFor(owner, org.id).marketplace.markReviewHelpful({ reviewId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await callerFor(a, org.id).marketplace.markReviewHelpful({ reviewId });
    await callerFor(a, org.id).marketplace.markReviewHelpful({ reviewId });
    const res = await callerFor(b, org.id).marketplace.markReviewHelpful({ reviewId });
    expect(res.helpful).toBe(2);
    expect(await prisma.connectorReviewVote.count()).toBe(2);
    const undo = await callerFor(a, org.id).marketplace.markReviewHelpful({ reviewId, helpful: false });
    expect(undo.helpful).toBe(1);
    expect((await prisma.connectorReview.findUniqueOrThrow({ where: { id: reviewId } })).helpful).toBe(1);
  });

  it("blocks viewers from reviewing and voting", async () => {
    const { owner, org, project } = await workspace();
    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    await callerFor(owner, org.id).marketplace.install({ slug: "gong", projectId: project.id });
    const { reviewId } = await callerFor(owner, org.id).marketplace.addReview({ slug: "gong", rating: 3 });
    await expect(callerFor(viewer, org.id).marketplace.addReview({ slug: "gong", rating: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(viewer, org.id).marketplace.markReviewHelpful({ reviewId })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("setup guide renderer", () => {
  const hostile = [
    "# Setup",
    "<script>alert('x')</script>",
    "<img src=x onerror=alert(1)>",
    "[click](javascript:alert(1))",
    "[enc](jav&#x61;script:alert(1))",
    "[tab](java\tscript:alert(1))",
    "[data](data:text/html;base64,PHNjcmlwdD4=)",
    "[proto](//evil.example/x)",
    "[slash](/&#x2f;evil.example)",
    "[ok](https://docs.example.com/setup)",
    "[local](/integrations)",
    "- **bold** and `code`",
  ].join("\n\n");

  it("neutralizes script tags and unsafe links", () => {
    const html = renderToStaticMarkup(createElement(SafeMarkdown, { source: hostile }));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/href="(javascript|data|vbscript):/i);
    expect(html).not.toMatch(/href="\/\//);
    expect(html).toContain("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;");
    expect(html).toContain('href="https://docs.example.com/setup"');
    expect(html).toContain('href="/integrations"');
    expect(html).toContain("<strong>");
    expect(html).toContain("<code");
    expect((html.match(/<a /g) ?? []).length).toBe(2);
  });

  it("parses the supported Markdown subset", () => {
    const blocks = parseMarkdown("## Title\n\n1. one\n2. two\n\n```\nraw <b>\n```\n\n> quote\n\n---");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "code", "quote", "hr"]);
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[2]).toEqual({ kind: "code", text: "raw <b>" });
  });

  it("allows only http(s) and same-origin hrefs", () => {
    expect(safeHref("https://a.example/x?y=1&z=2")).toBe("https://a.example/x?y=1&z=2");
    expect(safeHref("/marketplace/slack")).toBe("/marketplace/slack");
    for (const bad of ["javascript:alert(1)", " JAVASCRIPT:alert(1)", "vbscript:x", "data:text/html,x", "//evil.example", "/\\evil.example", "https://user:pw@a.example", "mailto:a@b.c", "jav&#x61;script:x"]) {
      expect(safeHref(bad)).toBeNull();
    }
  });

  it("renders every seeded setup guide without raw HTML", () => {
    for (const c of BUILTIN_MARKETPLACE_CONNECTORS) {
      const html = renderToStaticMarkup(createElement(SafeMarkdown, { source: c.setupGuide }));
      expect(html).not.toMatch(/<script|javascript:/i);
      expect(html).toContain("<ol");
    }
  });
});
