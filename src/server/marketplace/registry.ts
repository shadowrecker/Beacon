/**
 * Marketplace catalog: one official connector per implemented integration.
 *
 * The catalog lives in the database (MarketplaceConnector). `ensureMarketplaceSeeded`
 * upserts these built-ins by slug: idempotent, safe to call from the seed
 * script and lazily (once per process) from marketplace.browse. Install counts
 * and ratings are never overwritten by a re-seed.
 */
import type { AuthType, ConnectorPricing, IntegrationProvider, MarketplaceCategory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export interface MarketplaceConnectorData {
  slug: string;
  name: string;
  description: string;
  longDescription: string;
  category: MarketplaceCategory;
  /** IntegrationProvider this connector installs. */
  provider: IntegrationProvider;
  authType: AuthType;
  /** Markdown; rendered with the safe renderer (no raw HTML). */
  setupGuide: string;
  capabilities: string[];
  pricing: ConnectorPricing;
  publisherName: string;
  publisherUrl: string;
  isOfficial: boolean;
  isVerified: boolean;
  version: string;
}

const OAUTH_GUIDE = (name: string, steps: string[], extra = "") =>
  `## Connect ${name}

1. Click **Install**, choose the Beacon project that synced records should land in, and continue to ${name}.
${steps.map((s, i) => `${i + 2}. ${s}`).join("\n")}
${steps.length + 2}. You're returned to Beacon and the first sync starts automatically.

### What Beacon reads
${extra}

### Disconnecting
Disconnect from **Integrations** at any time. Beacon revokes its token where ${name} supports it and deletes the stored credentials. Documents already synced stay in your project.`;

const TOKEN_GUIDE = (name: string, steps: string[], reads: string, revoke: string) =>
  `## Connect ${name}

${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
${steps.length + 1}. In Beacon, click **Install**, pick the target project and paste the values. Beacon checks them live before saving.

### What Beacon reads
${reads}

### Security
Credentials are encrypted at rest and never shown again after saving (only a masked form).

### Revoking access
${revoke}`;

const PUBLISHER = { publisherName: "Beacon", publisherUrl: "https://beacon.app", isOfficial: true, isVerified: true, version: "2.0.0", pricing: "FREE" as const };

export const BUILTIN_MARKETPLACE_CONNECTORS: MarketplaceConnectorData[] = [
  {
    slug: "intercom",
    name: "Intercom",
    description: "Sync customer conversations into your research projects.",
    longDescription:
      "Every Intercom conversation, with the customer's messages and your team's replies, becomes a searchable support document in Beacon, ready for synthesis and recommendations.",
    category: "SUPPORT",
    provider: "INTERCOM",
    authType: "OAUTH2",
    setupGuide: OAUTH_GUIDE("Intercom", ["Pick your workspace's data region (US, EU or Australia).", "Approve read access in Intercom."], "- Conversations updated since the last sync (30 days on the first sync)\n- Customer messages, agent replies and internal notes, as plain text"),
    capabilities: ["Conversations", "Agent replies", "Incremental sync"],
    ...PUBLISHER,
  },
  {
    slug: "zendesk",
    name: "Zendesk",
    description: "Turn support tickets and their threads into evidence.",
    longDescription: "Zendesk tickets, including public replies and internal notes, are synced incrementally using Zendesk's cursor-based export.",
    category: "SUPPORT",
    provider: "ZENDESK",
    authType: "OAUTH2",
    setupGuide: OAUTH_GUIDE("Zendesk", ["Enter your Zendesk subdomain (the `acme` in `acme.zendesk.com`).", "Sign in to Zendesk and approve read-only access."], "- Tickets created or updated since the last sync\n- Each ticket's comment thread (up to 100 comments)"),
    capabilities: ["Tickets", "Comment threads", "Incremental export"],
    ...PUBLISHER,
  },
  {
    slug: "gong",
    name: "Gong",
    description: "Bring call transcripts with speaker names into Beacon.",
    longDescription: "Gong call transcripts, attributed to the internal and external participants, become transcript documents for synthesis.",
    category: "COMMUNICATION",
    provider: "GONG",
    authType: "OAUTH2",
    setupGuide: OAUTH_GUIDE("Gong", ["Approve access to call details and transcripts in Gong."], "- Calls started since the last sync\n- Transcripts with speaker names and affiliation"),
    capabilities: ["Call transcripts", "Speaker attribution"],
    ...PUBLISHER,
  },
  {
    slug: "slack",
    name: "Slack",
    description: "Capture feedback from the channels where it's shared.",
    longDescription: "Messages and thread replies from the Slack channels you choose (or public channels the Beacon app is added to) are synced as notes.",
    category: "COMMUNICATION",
    provider: "SLACK",
    authType: "OAUTH2",
    setupGuide: OAUTH_GUIDE(
      "Slack",
      ["Approve the Beacon app in your Slack workspace.", "Add the Beacon app to your feedback channels (or list channel IDs in the integration settings)."],
      "- Messages in the selected channels and their thread replies\n- Display names of the people who posted"
    ),
    capabilities: ["Channel messages", "Threads", "Workflow notifications"],
    ...PUBLISHER,
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    description: "Sync Service Hub tickets.",
    longDescription: "HubSpot tickets, with subject, description, priority and category, are synced incrementally by last-modified date.",
    category: "CRM",
    provider: "HUBSPOT",
    authType: "OAUTH2",
    setupGuide: OAUTH_GUIDE("HubSpot", ["Choose the HubSpot account and approve ticket access."], "- Tickets modified since the last sync"),
    capabilities: ["Tickets", "Incremental sync"],
    ...PUBLISHER,
  },
  {
    slug: "salesforce",
    name: "Salesforce",
    description: "Analyze Service Cloud cases.",
    longDescription: "Salesforce cases and their comments are synced from your org (production or sandbox) and analyzed alongside other feedback.",
    category: "CRM",
    provider: "SALESFORCE",
    authType: "OAUTH2",
    setupGuide: OAUTH_GUIDE("Salesforce", ["Choose production or sandbox.", "Sign in to Salesforce and allow access."], "- Cases modified since the last sync\n- Up to 20 comments per case"),
    capabilities: ["Cases", "Case comments", "Sandbox support"],
    ...PUBLISHER,
  },
  {
    slug: "linear",
    name: "Linear",
    description: "Sync issues and customer requests from Linear.",
    longDescription: "Linear issues, with labels, status and comments, are synced so product requests sit next to customer evidence.",
    category: "PRODUCT",
    provider: "LINEAR",
    authType: "API_KEY",
    setupGuide: TOKEN_GUIDE(
      "Linear",
      ["In Linear, open **Settings → Security & access → Personal API keys**.", "Create a key with read access and copy it."],
      "- Issues updated since the last sync (optionally only some teams)\n- Up to 20 comments per issue",
      "Delete the key in Linear's settings. Disconnecting in Beacon deletes the stored key."
    ),
    capabilities: ["Issues", "Comments", "Issue export"],
    ...PUBLISHER,
  },
  {
    slug: "jira",
    name: "Jira",
    description: "Sync Jira Cloud issues and comments.",
    longDescription: "Jira issues from the projects you choose are synced, and recommendations can be exported back as Jira issues.",
    category: "PRODUCT",
    provider: "JIRA",
    authType: "API_KEY",
    setupGuide: TOKEN_GUIDE(
      "Jira",
      ["Go to [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).", "Create a token and copy it.", "Note your site name: the `acme` in `acme.atlassian.net`."],
      "- Issues updated since the last sync (optionally only some projects)\n- Issue comments",
      "Revoke the token at id.atlassian.com. Disconnecting in Beacon deletes the stored token."
    ),
    capabilities: ["Issues", "Comments", "Issue export"],
    ...PUBLISHER,
  },
  {
    slug: "notion",
    name: "Notion",
    description: "Sync research notes and interview pages.",
    longDescription: "Pages shared with your Beacon integration in Notion are synced as notes, including nested list and toggle content.",
    category: "RESEARCH",
    provider: "NOTION",
    authType: "API_KEY",
    setupGuide: TOKEN_GUIDE(
      "Notion",
      ["Open [notion.so/my-integrations](https://www.notion.so/my-integrations) and create an internal integration.", "Copy its **Internal integration secret**.", "Share the pages or databases you want synced with the integration (**•••** → **Connections**)."],
      "- Pages edited since the last sync that are shared with the integration",
      "Delete the integration in Notion. Disconnecting in Beacon deletes the stored secret."
    ),
    capabilities: ["Pages", "Nested blocks"],
    ...PUBLISHER,
  },
  {
    slug: "productboard",
    name: "Productboard",
    description: "Sync customer feedback notes.",
    longDescription: "Productboard notes, with customer, company and tags, are synced so feedback captured there feeds Beacon's synthesis.",
    category: "PRODUCT",
    provider: "PRODUCTBOARD",
    authType: "API_KEY",
    setupGuide: TOKEN_GUIDE(
      "Productboard",
      ["In Productboard, open **Settings → Integrations → Public API**.", "Generate an access token and copy it."],
      "- Notes updated since the last sync",
      "Delete the token in Productboard. Disconnecting in Beacon deletes the stored token."
    ),
    capabilities: ["Feedback notes", "Tags"],
    ...PUBLISHER,
  },
  {
    slug: "mixpanel",
    name: "Mixpanel",
    description: "Add daily product-usage summaries.",
    longDescription: "A daily summary of your top Mixpanel events (event and unique-user counts) is added to your project as context for analysis.",
    category: "ANALYTICS",
    provider: "MIXPANEL",
    authType: "BASIC",
    setupGuide: TOKEN_GUIDE(
      "Mixpanel",
      ["In Mixpanel, open **Organization settings → Service accounts** and create one with access to your project.", "Copy the username and secret, and your numeric **Project ID**."],
      "- Daily totals for your 15 most-used events (no raw event data)",
      "Delete the service account in Mixpanel. Disconnecting in Beacon deletes the stored secret."
    ),
    capabilities: ["Daily event counts", "Unique users"],
    ...PUBLISHER,
  },
  {
    slug: "amplitude",
    name: "Amplitude",
    description: "Add daily product-usage summaries.",
    longDescription: "A daily summary of your top Amplitude events (event and unique-user counts) is added to your project as context for analysis.",
    category: "ANALYTICS",
    provider: "AMPLITUDE",
    authType: "API_KEY",
    setupGuide: TOKEN_GUIDE(
      "Amplitude",
      ["In Amplitude, open **Settings → Projects** and select your project.", "Copy the **API key** and **Secret key**."],
      "- Daily totals for your 15 most-used events (no raw event data)",
      "Rotate the project's secret key in Amplitude. Disconnecting in Beacon deletes the stored keys."
    ),
    capabilities: ["Daily event counts", "Unique users"],
    ...PUBLISHER,
  },
];

let seeded: Promise<void> | null = null;

async function seedAll(): Promise<void> {
  for (const c of BUILTIN_MARKETPLACE_CONNECTORS) {
    const data = {
      name: c.name,
      description: c.description,
      longDescription: c.longDescription,
      category: c.category,
      provider: c.provider,
      authType: c.authType,
      setupGuide: c.setupGuide,
      capabilities: c.capabilities,
      pricing: c.pricing,
      publisherName: c.publisherName,
      publisherUrl: c.publisherUrl,
      isOfficial: c.isOfficial,
      isVerified: c.isVerified,
      version: c.version,
      screenshotUrls: [] as string[],
    };
    await prisma.marketplaceConnector.upsert({ where: { slug: c.slug }, update: data, create: { slug: c.slug, ...data } });
  }
}

/** Upsert the built-in catalog (once per process; retried on failure). */
export function ensureMarketplaceSeeded(): Promise<void> {
  seeded ??= seedAll().catch((err) => {
    seeded = null;
    logger.error("marketplace seed failed", { err });
    throw err;
  });
  return seeded;
}

/** Test-only: forget that this process already seeded. */
export function resetMarketplaceSeedForTests(): void {
  seeded = null;
}
