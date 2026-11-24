/**
 * Plan entitlements: per-plan limits enforced server-side.
 *
 * `plan` on Organization is writable only by the server-side admin path
 * (src/app/api/admin/orgs/[orgId]/plan/route.ts), never by org members.
 */
import type { OrgPlan } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

export interface PlanLimits {
  /** LLM tokens (input + output) per calendar month. */
  monthlyTokens: number;
  maxProjects: number;
  maxMembers: number;
  maxIntegrations: number;
  maxApiKeys: number;
  maxWebhooks: number;
  maxWorkflows: number;
}

export const PLAN_LIMITS: Record<OrgPlan, PlanLimits> = {
  FREE: {
    monthlyTokens: 2_000_000,
    maxProjects: 3,
    maxMembers: 3,
    maxIntegrations: 2,
    maxApiKeys: 2,
    maxWebhooks: 2,
    maxWorkflows: 5,
  },
  TEAM: {
    monthlyTokens: 30_000_000,
    maxProjects: 50,
    maxMembers: 50,
    maxIntegrations: 12,
    maxApiKeys: 20,
    maxWebhooks: 20,
    maxWorkflows: 100,
  },
  ENTERPRISE: {
    monthlyTokens: 500_000_000,
    maxProjects: 10_000,
    maxMembers: 10_000,
    maxIntegrations: 100,
    maxApiKeys: 200,
    maxWebhooks: 200,
    maxWorkflows: 10_000,
  },
};

export type CountedResource = "projects" | "members" | "integrations" | "apiKeys" | "webhooks" | "workflows";

const LIMIT_KEY: Record<CountedResource, keyof PlanLimits> = {
  projects: "maxProjects",
  members: "maxMembers",
  integrations: "maxIntegrations",
  apiKeys: "maxApiKeys",
  webhooks: "maxWebhooks",
  workflows: "maxWorkflows",
};

export async function getOrgPlan(orgId: string): Promise<OrgPlan> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  return org?.plan ?? "FREE";
}

async function countResource(orgId: string, resource: CountedResource): Promise<number> {
  switch (resource) {
    case "projects":
      return prisma.project.count({ where: { orgId } });
    case "members":
      return (
        (await prisma.orgMember.count({ where: { orgId } })) +
        (await prisma.orgInvite.count({ where: { orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }))
      );
    case "integrations":
      // Disconnected rows are kept for history (synced documents, sync log) and
      // don't occupy a plan slot.
      return prisma.integration.count({ where: { orgId, status: { not: "DISCONNECTED" } } });
    case "apiKeys":
      return prisma.apiKey.count({ where: { orgId, revokedAt: null } });
    case "webhooks":
      return prisma.webhook.count({ where: { orgId } });
    case "workflows":
      return prisma.workflow.count({ where: { project: { orgId } } });
  }
}

/** Throw FORBIDDEN when creating one more `resource` would exceed the plan. */
export async function assertCanCreate(orgId: string, resource: CountedResource): Promise<void> {
  const plan = await getOrgPlan(orgId);
  const limit = PLAN_LIMITS[plan][LIMIT_KEY[resource]];
  const current = await countResource(orgId, resource);
  if (current >= limit) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Your ${plan.toLowerCase()} plan allows ${limit} ${resource}. Upgrade to add more.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Token budgets
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function monthStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function usageCacheKey(orgId: string): string {
  const m = monthStart();
  return `usage:tokens:${orgId}:${m.getUTCFullYear()}-${m.getUTCMonth() + 1}`;
}

export async function monthlyTokensUsed(orgId: string): Promise<number> {
  const key = usageCacheKey(orgId);
  try {
    const cached = await getRedis().get(key);
    if (cached !== null) return Number(cached);
  } catch (err) {
    logger.warn("usage cache unavailable", { err });
  }
  // Deepgram usage is recorded in audio seconds, not tokens: it is tracked for
  // cost reporting but does not count toward the LLM token budget.
  const agg = await prisma.tokenUsage.aggregate({
    where: { orgId, createdAt: { gte: monthStart() }, provider: { not: "deepgram" } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  const total = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  try {
    await getRedis().set(key, String(total), "EX", 60);
  } catch {
    /* cache best-effort */
  }
  return total;
}

/** Throw BudgetExceededError when the org has exhausted its monthly tokens. */
export async function assertTokenBudget(orgId: string): Promise<void> {
  const plan = await getOrgPlan(orgId);
  const used = await monthlyTokensUsed(orgId);
  if (used >= PLAN_LIMITS[plan].monthlyTokens) {
    throw new BudgetExceededError(
      `Monthly AI usage limit reached for this workspace (${PLAN_LIMITS[plan].monthlyTokens.toLocaleString()} tokens).`
    );
  }
}

export interface UsageRecord {
  orgId: string;
  projectId?: string | null;
  feature: string;
  provider: "anthropic" | "openai" | "deepgram";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export async function recordTokenUsage(rec: UsageRecord): Promise<void> {
  await prisma.tokenUsage.create({
    data: {
      orgId: rec.orgId,
      projectId: rec.projectId ?? null,
      feature: rec.feature,
      provider: rec.provider,
      model: rec.model,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheReadTokens: rec.cacheReadTokens ?? 0,
      cacheWriteTokens: rec.cacheWriteTokens ?? 0,
    },
  });
  if (rec.provider === "deepgram") return;
  try {
    const key = usageCacheKey(rec.orgId);
    if ((await getRedis().exists(key)) === 1) {
      await getRedis().incrby(key, rec.inputTokens + rec.outputTokens);
    }
  } catch {
    /* cache best-effort; the DB row is authoritative */
  }
}
