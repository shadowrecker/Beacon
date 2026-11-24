/**
 * Outbound actions against connected integrations, shared by workflows,
 * engineering handoff and roadmap import.
 *
 * Credentials always come from the org's own integration
 * (getOrgIntegrationCredentials(orgId, ...)), where `orgId` is derived by the
 * caller from a resource it already authorized. Hosts are fixed or strictly
 * validated, and every request goes through safeFetch.
 */
import { safeFetch } from "@/lib/safe-fetch";
import { NonRetryableError } from "../jobs/worker";
import { getOrgIntegrationCredentials } from "./credentials";

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
const SLACK_CHANNEL = /^[CGD][A-Z0-9]{6,}$|^#[a-z0-9_-]{1,80}$/;

export class IntegrationNotConnectedError extends NonRetryableError {
  constructor(provider: string) {
    super(`${provider} is not connected for this workspace`);
    this.name = "IntegrationNotConnectedError";
  }
}

async function requireCreds(orgId: string, provider: "JIRA" | "LINEAR" | "SLACK") {
  const integ = await getOrgIntegrationCredentials(orgId, provider);
  if (!integ) throw new IntegrationNotConnectedError(provider);
  return integ;
}

function checkResponse(provider: string, res: { status: number; ok: boolean; text(): string }) {
  if (res.ok) return;
  // Only the status is surfaced: response bodies can echo internal details.
  const err = new Error(`${provider} request failed with status ${res.status}`) as Error & { status: number };
  err.status = res.status;
  throw err;
}

/** Jira Cloud site validation: credentials.siteSubdomain must be a bare subdomain. */
export function jiraBaseUrl(siteSubdomain: string): string {
  const s = siteSubdomain.trim().toLowerCase();
  if (!SUBDOMAIN.test(s)) throw new NonRetryableError("Invalid Jira site name");
  return `https://${s}.atlassian.net`;
}

function adfParagraphs(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split(/\n{2,}/)
      .slice(0, 100)
      .map((para) => ({ type: "paragraph", content: [{ type: "text", text: para.slice(0, 5000) }] })),
  };
}

export async function createJiraIssue(
  orgId: string,
  input: { summary: string; description: string; projectKey?: string; issueType?: string }
): Promise<{ key: string; url: string }> {
  const integ = await requireCreds(orgId, "JIRA");
  const { email, apiToken, siteSubdomain } = integ.credentials;
  if (!email || !apiToken || !siteSubdomain) throw new NonRetryableError("Jira credentials are incomplete");
  const config = (integ.config ?? {}) as { projectKey?: string; issueType?: string };
  const projectKey = input.projectKey ?? config.projectKey;
  if (!projectKey || !JIRA_PROJECT_KEY.test(projectKey)) throw new NonRetryableError("Invalid or missing Jira project key");
  const base = jiraBaseUrl(siteSubdomain);
  const res = await safeFetch(`${base}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary: input.summary.slice(0, 250),
        description: adfParagraphs(input.description),
        issuetype: { name: input.issueType ?? config.issueType ?? "Task" },
      },
    }),
    timeoutMs: 20_000,
  });
  checkResponse("Jira", res);
  const body = res.json<{ key: string }>();
  return { key: body.key, url: `${base}/browse/${encodeURIComponent(body.key)}` };
}

export async function createLinearIssue(
  orgId: string,
  input: { title: string; description: string; teamId?: string }
): Promise<{ id: string; identifier: string; url: string }> {
  const integ = await requireCreds(orgId, "LINEAR");
  const apiKey = integ.credentials.apiKey ?? integ.credentials.accessToken;
  if (!apiKey) throw new NonRetryableError("Linear credentials are incomplete");
  const teamId = input.teamId ?? ((integ.config ?? {}) as { teamId?: string }).teamId;
  if (!teamId || !/^[a-zA-Z0-9-]{1,64}$/.test(teamId)) throw new NonRetryableError("Invalid or missing Linear team");
  const res = await safeFetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      query:
        "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
      variables: { input: { teamId, title: input.title.slice(0, 250), description: input.description.slice(0, 50_000) } },
    }),
    timeoutMs: 20_000,
  });
  checkResponse("Linear", res);
  const body = res.json<{ data?: { issueCreate?: { success: boolean; issue?: { id: string; identifier: string; url: string } } }; errors?: unknown[] }>();
  const issue = body.data?.issueCreate?.issue;
  if (!body.data?.issueCreate?.success || !issue) throw new NonRetryableError("Linear rejected the issue");
  return issue;
}

export async function postSlackMessage(orgId: string, input: { text: string; channel?: string }): Promise<{ ts: string; channel: string }> {
  const integ = await requireCreds(orgId, "SLACK");
  const token = integ.credentials.botToken ?? integ.credentials.accessToken;
  if (!token) throw new NonRetryableError("Slack credentials are incomplete");
  const channel = input.channel ?? ((integ.config ?? {}) as { defaultChannel?: string }).defaultChannel;
  if (!channel || !SLACK_CHANNEL.test(channel)) throw new NonRetryableError("Invalid or missing Slack channel");
  const res = await safeFetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    // Plain text only (no link unfurling); mrkdwn escaping is applied by Slack for text.
    body: JSON.stringify({ channel, text: input.text.slice(0, 3500), unfurl_links: false, unfurl_media: false }),
    timeoutMs: 15_000,
  });
  checkResponse("Slack", res);
  const body = res.json<{ ok: boolean; ts?: string; channel?: string; error?: string }>();
  if (!body.ok || !body.ts) {
    if (body.error === "ratelimited") {
      const err = new Error("Slack rate limited") as Error & { status: number };
      err.status = 429;
      throw err;
    }
    throw new NonRetryableError(`Slack rejected the message (${body.error ?? "unknown"})`);
  }
  return { ts: body.ts, channel: body.channel ?? channel };
}
