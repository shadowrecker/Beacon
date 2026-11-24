/**
 * Test data factories and an authenticated tRPC caller.
 */
import type { OrgMemberRole } from "@prisma/client";
import { prisma } from "@/lib/db";

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface TestUser {
  id: string;
  clerkId: string;
  email: string;
  name: string;
  personalOrgId: string;
}

export async function createUser(overrides: { email?: string; name?: string } = {}): Promise<TestUser> {
  const n = next();
  const email = overrides.email ?? `user-${n}@example.test`;
  const name = overrides.name ?? `User ${n}`;
  const user = await prisma.user.create({ data: { clerkId: `clerk_${n}`, email, name } });
  const org = await prisma.organization.create({
    data: {
      name: `${name}'s workspace`,
      slug: `personal-${n}`,
      isPersonal: true,
      members: { create: { userId: user.id, role: "OWNER", joinedAt: new Date() } },
    },
  });
  return { id: user.id, clerkId: user.clerkId, email, name, personalOrgId: org.id };
}

export async function createOrg(owner: TestUser, overrides: { name?: string; plan?: "FREE" | "TEAM" | "ENTERPRISE" } = {}) {
  const n = next();
  return prisma.organization.create({
    data: {
      name: overrides.name ?? `Org ${n}`,
      slug: `org-${n}`,
      plan: overrides.plan ?? "TEAM",
      members: { create: { userId: owner.id, role: "OWNER", joinedAt: new Date() } },
    },
  });
}

export async function addMember(orgId: string, user: TestUser, role: OrgMemberRole) {
  return prisma.orgMember.create({ data: { orgId, userId: user.id, role, joinedAt: new Date() } });
}

export async function createProject(user: TestUser, orgId?: string, name = "Test project") {
  return prisma.project.create({
    data: { name, userId: user.id, orgId: orgId ?? user.personalOrgId },
  });
}

export async function createReadyDocument(projectId: string, title: string, text: string) {
  return prisma.document.create({
    data: {
      projectId,
      title,
      type: "TRANSCRIPT",
      source: "UPLOAD",
      mimeType: "text/plain",
      processedText: text,
      status: "READY",
    },
  });
}
