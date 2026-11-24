/**
 * Connector registry and the provider catalog shown in the UI.
 */
import type { IntegrationProvider } from "@prisma/client";
import { amplitudeConnector } from "./amplitude";
import { gongConnector } from "./gong";
import { hubspotConnector } from "./hubspot";
import { intercomConnector } from "./intercom";
import { jiraConnector } from "./jira";
import { linearConnector } from "./linear";
import { mixpanelConnector } from "./mixpanel";
import { notionConnector } from "./notion";
import { productboardConnector } from "./productboard";
import { salesforceConnector } from "./salesforce";
import { slackConnector } from "./slack";
import type { Connector } from "./types";
import { zendeskConnector } from "./zendesk";

export const PROVIDERS = [
  "INTERCOM",
  "ZENDESK",
  "GONG",
  "SLACK",
  "HUBSPOT",
  "AMPLITUDE",
  "MIXPANEL",
  "SALESFORCE",
  "LINEAR",
  "JIRA",
  "NOTION",
  "PRODUCTBOARD",
] as const satisfies readonly IntegrationProvider[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONNECTORS: Record<IntegrationProvider, Connector<any>> = {
  INTERCOM: intercomConnector,
  ZENDESK: zendeskConnector,
  GONG: gongConnector,
  SLACK: slackConnector,
  HUBSPOT: hubspotConnector,
  AMPLITUDE: amplitudeConnector,
  MIXPANEL: mixpanelConnector,
  SALESFORCE: salesforceConnector,
  LINEAR: linearConnector,
  JIRA: jiraConnector,
  NOTION: notionConnector,
  PRODUCTBOARD: productboardConnector,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getConnector(provider: IntegrationProvider): Connector<any> {
  return CONNECTORS[provider];
}

export const OAUTH_PROVIDERS = ["SLACK", "HUBSPOT", "INTERCOM", "GONG", "SALESFORCE", "ZENDESK"] as const satisfies readonly IntegrationProvider[];
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export const API_KEY_PROVIDERS = ["LINEAR", "JIRA", "NOTION", "PRODUCTBOARD", "MIXPANEL", "AMPLITUDE"] as const satisfies readonly IntegrationProvider[];
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export function isOAuthProvider(p: IntegrationProvider): p is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(p);
}

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "password" | "email" | "select" | "list";
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
}

export interface ProviderInfo {
  provider: IntegrationProvider;
  name: string;
  description: string;
  category: "Support" | "Sales" | "Calls" | "Communication" | "Product" | "Analytics" | "Docs";
  auth: "oauth" | "apiKey";
  /** What a sync brings in. */
  syncs: string;
  /** API-token providers: fields for integration.connect. */
  credentialFields: FieldSpec[];
  /** OAuth providers: extra parameters for /api/integrations/oauth/start. */
  startFields: FieldSpec[];
  /** User-editable settings (integration.updateConfig). */
  configFields: FieldSpec[];
  /** Where a user revokes access on the provider side. */
  revokeHelp: string;
  docsUrl: string;
}

const INTERVAL: FieldSpec = {
  key: "syncIntervalMinutes",
  label: "Sync every",
  type: "select",
  options: [
    { value: "60", label: "Hour" },
    { value: "360", label: "6 hours" },
    { value: "720", label: "12 hours" },
    { value: "1440", label: "Day" },
  ],
};

export const PROVIDER_CATALOG: ProviderInfo[] = [
  {
    provider: "INTERCOM",
    name: "Intercom",
    description: "Customer conversations and support replies.",
    category: "Support",
    auth: "oauth",
    syncs: "Conversations with every customer message and agent reply",
    credentialFields: [],
    startFields: [
      {
        key: "region",
        label: "Data region",
        type: "select",
        options: [
          { value: "us", label: "United States" },
          { value: "eu", label: "Europe" },
          { value: "au", label: "Australia" },
        ],
      },
    ],
    configFields: [INTERVAL],
    revokeHelp: "Disconnecting uninstalls Beacon from your Intercom workspace.",
    docsUrl: "https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/setting-up-oauth",
  },
  {
    provider: "ZENDESK",
    name: "Zendesk",
    description: "Support tickets and their comment threads.",
    category: "Support",
    auth: "oauth",
    syncs: "Tickets with public replies and internal notes",
    credentialFields: [],
    startFields: [
      { key: "subdomain", label: "Zendesk subdomain", type: "text", placeholder: "acme", help: "The part before .zendesk.com", required: true },
    ],
    configFields: [INTERVAL],
    revokeHelp: "Disconnecting revokes Beacon's OAuth token in Zendesk.",
    docsUrl: "https://support.zendesk.com/hc/en-us/articles/4408845965210",
  },
  {
    provider: "GONG",
    name: "Gong",
    description: "Sales and customer call transcripts with speakers.",
    category: "Calls",
    auth: "oauth",
    syncs: "Call transcripts with participant names",
    credentialFields: [],
    startFields: [],
    configFields: [INTERVAL],
    revokeHelp: "Gong has no token revocation API: also remove Beacon under Company settings → Ecosystem → API in Gong.",
    docsUrl: "https://help.gong.io/docs/create-an-app-for-gong",
  },
  {
    provider: "SLACK",
    name: "Slack",
    description: "Feedback channels, with thread replies.",
    category: "Communication",
    auth: "oauth",
    syncs: "Messages and thread replies from the channels you choose",
    credentialFields: [],
    startFields: [],
    configFields: [
      {
        key: "channelIds",
        label: "Channels to sync",
        type: "list",
        placeholder: "C0123456789",
        help: "Channel IDs (channel details → About). Leave empty to sync public channels the Beacon app is in.",
      },
      { key: "defaultChannel", label: "Default channel for notifications", type: "text", placeholder: "C0123456789 or #product" },
      INTERVAL,
    ],
    revokeHelp: "Disconnecting revokes Beacon's bot token in your Slack workspace.",
    docsUrl: "https://api.slack.com/authentication/oauth-v2",
  },
  {
    provider: "HUBSPOT",
    name: "HubSpot",
    description: "Service Hub tickets.",
    category: "Sales",
    auth: "oauth",
    syncs: "Tickets with subject, description, priority and category",
    credentialFields: [],
    startFields: [],
    configFields: [INTERVAL],
    revokeHelp: "Disconnecting revokes Beacon's refresh token in HubSpot.",
    docsUrl: "https://developers.hubspot.com/docs/api/oauth-quickstart-guide",
  },
  {
    provider: "SALESFORCE",
    name: "Salesforce",
    description: "Service Cloud cases and case comments.",
    category: "Sales",
    auth: "oauth",
    syncs: "Cases with description and comments",
    credentialFields: [],
    startFields: [
      {
        key: "environment",
        label: "Environment",
        type: "select",
        options: [
          { value: "production", label: "Production" },
          { value: "sandbox", label: "Sandbox" },
        ],
      },
    ],
    configFields: [INTERVAL],
    revokeHelp: "Disconnecting revokes Beacon's refresh token in Salesforce.",
    docsUrl: "https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_web_server_flow.htm",
  },
  {
    provider: "LINEAR",
    name: "Linear",
    description: "Issues and comments, including customer requests.",
    category: "Product",
    auth: "apiKey",
    syncs: "Issues with description, labels and comments",
    credentialFields: [
      { key: "apiKey", label: "Personal API key", type: "password", placeholder: "lin_api_…", help: "Linear → Settings → Security & access → Personal API keys", required: true },
    ],
    startFields: [],
    configFields: [
      { key: "teamKeys", label: "Teams to sync", type: "list", placeholder: "ENG", help: "Team keys. Leave empty for all teams." },
      { key: "teamId", label: "Default team ID", type: "text", help: "Team used for issue export and roadmap import (Linear team UUID)." },
      INTERVAL,
    ],
    revokeHelp: "Linear keys can't be revoked by Beacon: delete the key in Linear → Settings → Security & access.",
    docsUrl: "https://linear.app/docs/api-and-webhooks",
  },
  {
    provider: "JIRA",
    name: "Jira",
    description: "Jira Cloud issues and comments.",
    category: "Product",
    auth: "apiKey",
    syncs: "Issues with description, labels and comments",
    credentialFields: [
      { key: "siteSubdomain", label: "Site", type: "text", placeholder: "acme", help: "The part before .atlassian.net", required: true },
      { key: "email", label: "Atlassian account email", type: "email", required: true },
      { key: "apiToken", label: "API token", type: "password", help: "id.atlassian.com → Security → API tokens", required: true },
    ],
    startFields: [],
    configFields: [
      { key: "projectKeys", label: "Projects to sync", type: "list", placeholder: "PROD", help: "Project keys. Leave empty for all projects." },
      { key: "projectKey", label: "Default project for new issues", type: "text", placeholder: "PROD" },
      INTERVAL,
    ],
    revokeHelp: "Atlassian tokens can't be revoked by Beacon: delete the token at id.atlassian.com → Security → API tokens.",
    docsUrl: "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/",
  },
  {
    provider: "NOTION",
    name: "Notion",
    description: "Research notes and interview pages.",
    category: "Docs",
    auth: "apiKey",
    syncs: "Pages shared with the Beacon integration",
    credentialFields: [
      { key: "apiKey", label: "Internal integration secret", type: "password", placeholder: "ntn_…", help: "notion.so/my-integrations → your integration → Secrets. Then share pages with it.", required: true },
    ],
    startFields: [],
    configFields: [
      { key: "databaseId", label: "Roadmap database ID", type: "text", help: "Optional: the database used for roadmap import (32 characters from its URL)." },
      INTERVAL,
    ],
    revokeHelp: "Delete the internal integration at notion.so/my-integrations to revoke its secret.",
    docsUrl: "https://developers.notion.com/docs/create-a-notion-integration",
  },
  {
    provider: "PRODUCTBOARD",
    name: "Productboard",
    description: "Customer feedback notes.",
    category: "Product",
    auth: "apiKey",
    syncs: "Notes with customer, company and tags",
    credentialFields: [
      { key: "apiToken", label: "Access token", type: "password", help: "Productboard → Settings → Integrations → Public API", required: true },
    ],
    startFields: [],
    configFields: [INTERVAL],
    revokeHelp: "Delete the token in Productboard → Settings → Integrations → Public API.",
    docsUrl: "https://developer.productboard.com/reference/introduction",
  },
  {
    provider: "MIXPANEL",
    name: "Mixpanel",
    description: "Daily product-usage summaries.",
    category: "Analytics",
    auth: "apiKey",
    syncs: "Top events per day with event and unique-user counts",
    credentialFields: [
      { key: "serviceAccountUsername", label: "Service account username", type: "text", required: true },
      { key: "serviceAccountSecret", label: "Service account secret", type: "password", required: true },
      { key: "projectId", label: "Project ID", type: "text", placeholder: "1234567", required: true },
    ],
    startFields: [],
    configFields: [
      {
        key: "region",
        label: "Data residency",
        type: "select",
        options: [
          { value: "us", label: "United States" },
          { value: "eu", label: "Europe" },
          { value: "in", label: "India" },
        ],
      },
      INTERVAL,
    ],
    revokeHelp: "Delete the service account in Mixpanel → Organization settings → Service accounts.",
    docsUrl: "https://developer.mixpanel.com/reference/service-accounts",
  },
  {
    provider: "AMPLITUDE",
    name: "Amplitude",
    description: "Daily product-usage summaries.",
    category: "Analytics",
    auth: "apiKey",
    syncs: "Top events per day with event and unique-user counts",
    credentialFields: [
      { key: "apiKey", label: "API key", type: "password", required: true },
      { key: "secretKey", label: "Secret key", type: "password", required: true, help: "Amplitude → Settings → Projects → your project → General" },
    ],
    startFields: [],
    configFields: [
      {
        key: "region",
        label: "Data region",
        type: "select",
        options: [
          { value: "us", label: "United States" },
          { value: "eu", label: "Europe" },
        ],
      },
      INTERVAL,
    ],
    revokeHelp: "Rotate the project's secret key in Amplitude to revoke access.",
    docsUrl: "https://amplitude.com/docs/apis/analytics/dashboard-rest",
  },
];

export function providerInfo(provider: IntegrationProvider): ProviderInfo {
  return PROVIDER_CATALOG.find((p) => p.provider === provider)!;
}
