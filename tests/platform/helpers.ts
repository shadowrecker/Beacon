/**
 * Shared fixtures for the platform tests.
 */
import type { DomainEvent, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { encryptCredentials } from "@/server/integrations/credentials";
import type { EventPayload, EventType } from "@/server/events/catalog";
import { addMember, createOrg, createProject, createUser, type TestUser } from "../helpers/factories";

export const log = logger.child({ test: "platform" });

export interface Tenant {
  owner: TestUser;
  orgId: string;
  projectId: string;
}

export async function createTenant(name: string): Promise<Tenant> {
  const owner = await createUser({ name: `${name} owner` });
  const org = await createOrg(owner, { name, plan: "TEAM" });
  const project = await createProject(owner, org.id, `${name} project`);
  return { owner, orgId: org.id, projectId: project.id };
}

export async function memberOf(orgId: string, role: "ADMIN" | "MEMBER" | "VIEWER"): Promise<TestUser> {
  const user = await createUser({ name: `${role.toLowerCase()} user` });
  await addMember(orgId, user, role);
  return user;
}

export async function connectIntegration(
  t: Tenant,
  provider: "JIRA" | "LINEAR" | "SLACK",
  credentials: Record<string, string>,
  config: Prisma.InputJsonValue = {}
) {
  return prisma.integration.create({
    data: {
      orgId: t.orgId,
      userId: t.owner.id,
      provider,
      status: "CONNECTED",
      config,
      ...encryptCredentials(credentials),
    },
  });
}

export async function createRecommendation(projectId: string, title = "Add SSO") {
  return prisma.recommendation.create({
    data: {
      projectId,
      title,
      description: `${title}: customers keep asking for it.`,
      impact: "HIGH",
      confidence: 0.9,
      evidence: {
        themes: [{ id: "theme-sso", name: "Enterprise SSO" }],
        quotes: [
          { chunkId: "chunk-1", documentId: "doc-1", documentTitle: "Interview", quote: "We cannot roll this out without SSO." },
          { chunkId: "chunk-2", documentId: "doc-2", documentTitle: "Ticket", quote: "SSO is a blocker for our security review." },
        ],
        rationale: "Security reviews block enterprise deals.",
        modelConfidence: 0.9,
      },
    },
  });
}

/** Insert a DomainEvent row directly (no fan-out), for subscriber/worker tests. */
export async function insertEvent<T extends EventType>(
  t: { orgId: string; projectId: string | null },
  type: T,
  payload: EventPayload<T>,
  causationDepth = 0
): Promise<DomainEvent> {
  return prisma.domainEvent.create({
    data: { orgId: t.orgId, projectId: t.projectId, type, payload: payload as Prisma.InputJsonValue, causationDepth },
  });
}

export function jobMeta(attempt = 1, maxAttempts = 3) {
  return { jobId: `test-${attempt}`, attempt, maxAttempts };
}
