/**
 * Development seed: a demo workspace with realistic customer research.
 *
 *   npx prisma db seed            (or: npx tsx scripts/seed.ts)
 *   npx tsx scripts/seed.ts --reset    # delete and recreate the demo workspace
 *
 * Creates a demo user (with a personal workspace), a team workspace "Acme
 * (demo)", two projects and their documents. Documents go through the normal
 * ingestion path (createDocumentFromText), so a running worker chunks and
 * embeds them like any other document.
 *
 * Set SEED_MEMBER_EMAIL to the email you signed in with to be added to the demo
 * workspace as an admin.
 *
 * Refuses to run when NODE_ENV=production or when DATABASE_URL does not point
 * at a local database. Never deletes anything outside the demo workspace.
 */
import path from "node:path";
import type { DocumentType } from "@prisma/client";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const DEMO_ORG_SLUG = "acme-demo";
const DEMO_CLERK_ID = "seed_demo_user";

/** Throws unless seeding is safe: not production, and the database host is local. */
export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV is production.");
  }
  const url = env.DATABASE_URL;
  if (!url) throw new Error("Refusing to seed: DATABASE_URL is not set.");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("Refusing to seed: DATABASE_URL is not a valid URL.");
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to seed: database host "${host}" is not local.`);
  }
}

interface SeedDocument {
  title: string;
  type: DocumentType;
  text: string;
}

const ONBOARDING_DOCS: SeedDocument[] = [
  {
    title: "Interview: Priya Natarajan, Operations Lead (logistics, 180 seats)",
    type: "TRANSCRIPT",
    text: `Interviewer: Thanks for making time, Priya. Can you walk me through how your team got started with the product?
Priya: Sure. We signed the contract in March and it took us almost five weeks to get everyone live. The software itself wasn't the problem, it was the setup.
Interviewer: What part of the setup took the longest?
Priya: The CSV import for our carrier list. We have about twelve thousand rows and the importer kept rejecting the file without saying which row was wrong. I ended up splitting the file into chunks of five hundred rows to find the bad ones. That alone was two days of my time.
Interviewer: Did support help?
Priya: They were friendly, but the answer was basically "check the template". The template had a date column in US format and our data is day-month-year. Nothing in the error told us that.
Interviewer: Anything else that slowed the rollout?
Priya: Single sign-on. Our IT team won't approve a tool unless it's behind Okta. SSO is only on the enterprise plan, so we had a month where people were sharing a login, which security was not happy about.
Interviewer: Once people were in, how has day-to-day use been?
Priya: Honestly, good. The live shipment dashboard is the thing my managers open every morning. Being able to share a dashboard link with a customer has cut a lot of "where is my order" emails.
Interviewer: If you could change one thing?
Priya: Make the first week less painful. A guided import that tells you exactly what's wrong, and SSO for teams our size.`,
  },
  {
    title: "Interview: Marcus Webb, Finance Manager (retail, 40 seats)",
    type: "TRANSCRIPT",
    text: `Interviewer: Marcus, what do you mostly use the product for?
Marcus: Month-end. I pull the usage and invoice data into our accounting system.
Interviewer: How does that go?
Marcus: The export is the weak spot. When I run the full-month export it times out after a couple of minutes. I have to export week by week and stitch the files together in a spreadsheet, which is exactly the kind of manual work we bought the tool to avoid.
Interviewer: How often does that happen?
Marcus: Every month-end, without fail. It's the one day I dread.
Interviewer: What about the invoices themselves?
Marcus: They're confusing. The line items show internal plan codes instead of what we actually bought, so every invoice turns into a ticket to your billing team. Last quarter we paid one late because nobody could reconcile it.
Interviewer: Is there anything you'd hate to lose?
Marcus: The scheduled reports. Getting the weekly summary in my inbox on Monday is genuinely useful.`,
  },
  {
    title: "Support tickets: onboarding queue, October",
    type: "SUPPORT_TICKET",
    text: `Ticket 4812 (priority high, plan Team): Import fails with "invalid file" on a 9,000 row CSV. No row number in the error. Customer split the file manually to find a stray comma.
Ticket 4820 (priority medium, plan Team): Customer asks whether SSO with Azure AD is available below the enterprise plan. Their IT policy blocks password logins.
Ticket 4833 (priority high, plan Business): Full-year export times out. Customer is exporting month by month as a workaround.
Ticket 4841 (priority low, plan Starter): Request for a dark mode on the dashboards.
Ticket 4856 (priority medium, plan Team): Invoice shows plan code "TM-ANNUAL-3" and the customer cannot tell what it refers to.
Ticket 4870 (priority high, plan Team): Importer rejected dates in DD/MM/YYYY format. Customer had to rewrite 4,000 dates.
Ticket 4877 (priority medium, plan Business): Asked for audit logs of who changed shipment statuses; needed for a compliance review.`,
  },
  {
    title: "Sales call notes: Northwind Freight (lost deal)",
    type: "NOTE",
    text: `Northwind evaluated us against two competitors over six weeks. They liked the dashboards and the customer-facing tracking links more than either alternative.

They chose the competitor because of two requirements we could not meet at their size: SAML single sign-on and an audit log of user actions. Their security questionnaire marked both as mandatory.

Their ops director also mentioned that a reference customer warned them our onboarding "takes a month if your data is messy". They asked whether we offer assisted data migration.

Follow-up: they said they would revisit next year if SSO becomes available on the team plan.`,
  },
  {
    title: "NPS survey verbatims, Q3",
    type: "OTHER",
    text: `Score 9: The dashboards are excellent and my team actually uses them every day.
Score 3: Setup was painful. The importer errors are useless and it took us weeks to get our data in.
Score 6: Good product, but we need SSO before we can roll it out to the whole company.
Score 8: Scheduled reports save me an hour every week.
Score 4: Exports time out on anything bigger than a month of data.
Score 7: Billing is confusing, otherwise solid.
Score 10: Sharing tracking links with customers has cut our support emails in half.`,
  },
];

const MOBILE_DOCS: SeedDocument[] = [
  {
    title: "Field team feedback: driver app beta",
    type: "NOTE",
    text: `Drivers in the beta like the new proof-of-delivery photo flow; it is faster than the paper slips.

The most common complaint is that the app logs drivers out every few hours, which means re-entering credentials in the cab. Several drivers asked for a "remember me" option or biometric login.

Offline mode is the other gap. In rural areas the app shows a spinner instead of the route when there is no signal. Drivers want the day's route cached in the morning.`,
  },
  {
    title: "App store reviews digest, September",
    type: "OTHER",
    text: `"Great for scanning parcels, but it keeps logging me out." (2 stars)
"Love the photo proof of delivery." (5 stars)
"Useless without signal. Please add offline routes." (1 star)
"Battery drain is noticeable on older Android phones." (3 stars)
"Much better than the old app, quick and simple." (5 stars)`,
  },
];

async function main(): Promise<void> {
  assertSeedAllowed(process.env);
  const reset = process.argv.includes("--reset");

  const { prisma } = await import("@/lib/db");
  const { upsertUserFromClerk } = await import("@/server/auth/provision");
  const { createDocumentFromText } = await import("@/server/documents/ingest");
  const { closeQueues } = await import("@/server/jobs/queues");
  const { closeRedis } = await import("@/lib/redis");

  try {
    // Global catalog data (idempotent upsert by slug; never resets counts or ratings).
    const { ensureMarketplaceSeeded } = await import("@/server/marketplace/registry");
    await ensureMarketplaceSeeded();
    console.log("Marketplace catalog seeded.");

    const existing = await prisma.organization.findUnique({ where: { slug: DEMO_ORG_SLUG }, select: { id: true } });
    if (existing && !reset) {
      console.log(`Demo workspace "${DEMO_ORG_SLUG}" already exists. Run with --reset to recreate it.`);
      return;
    }
    if (existing) {
      await prisma.organization.delete({ where: { id: existing.id } });
      console.log("Deleted the existing demo workspace.");
    }

    const { userId } = await upsertUserFromClerk({ clerkId: DEMO_CLERK_ID, email: "demo@beacon.local", name: "Demo PM", avatarUrl: null });
    const org = await prisma.organization.create({
      data: {
        name: "Acme (demo)",
        slug: DEMO_ORG_SLUG,
        plan: "TEAM",
        members: { create: { userId, role: "OWNER", joinedAt: new Date() } },
      },
      select: { id: true },
    });

    const memberEmail = process.env.SEED_MEMBER_EMAIL?.trim().toLowerCase();
    if (memberEmail) {
      const member = await prisma.user.findUnique({ where: { email: memberEmail }, select: { id: true } });
      if (member) {
        await prisma.orgMember.upsert({
          where: { orgId_userId: { orgId: org.id, userId: member.id } },
          update: { role: "ADMIN", joinedAt: new Date() },
          create: { orgId: org.id, userId: member.id, role: "ADMIN", joinedAt: new Date() },
        });
        console.log(`Added ${memberEmail} to the demo workspace as an admin.`);
      } else {
        console.warn(`SEED_MEMBER_EMAIL=${memberEmail} has no Beacon user yet; sign in once, then re-run with --reset.`);
      }
    }

    const projects: Array<{ name: string; description: string; docs: SeedDocument[] }> = [
      {
        name: "Self-serve onboarding research",
        description: "Why mid-market teams take weeks to go live, and what would make the first week easier.",
        docs: ONBOARDING_DOCS,
      },
      {
        name: "Driver app beta",
        description: "Feedback from the mobile driver app beta and app store reviews.",
        docs: MOBILE_DOCS,
      },
    ];

    for (const p of projects) {
      const project = await prisma.project.create({
        data: { name: p.name, description: p.description, orgId: org.id, userId },
        select: { id: true },
      });
      for (const d of p.docs) {
        await createDocumentFromText({
          projectId: project.id,
          title: d.title,
          type: d.type,
          source: "QUICK_CAPTURE",
          text: d.text,
          createdById: userId,
        });
      }
      console.log(`Created project "${p.name}" with ${p.docs.length} documents (queued for processing).`);
    }
    console.log("Seed complete. Start the worker (npm run worker) to process the documents.");
  } finally {
    await closeQueues().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    await prisma.$disconnect();
  }
}

const invokedDirectly = Boolean(process.argv[1]) && path.basename(process.argv[1]).replace(/\.[cm]?[jt]s$/, "") === "seed";
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
