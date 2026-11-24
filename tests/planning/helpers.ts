/**
 * Shared helpers for the planning tests (roadmap, analytics, outcomes,
 * presentations, handoff).
 */
import { prisma } from "@/lib/db";
import { runJob, type WorkerDefinition } from "@/server/jobs/worker";
import type { QueueName } from "@/server/jobs/queues";
import { createTestContext } from "@/server/context";
import { createCallerFactory, router } from "@/server/trpc";
import { roadmapRouter } from "@/server/routers/roadmap";
import { analyticsRouter } from "@/server/routers/analytics";
import { outcomeRouter } from "@/server/routers/outcome";
import { presentationRouter } from "@/server/routers/presentation";
import { handoffRouter } from "@/server/routers/handoff";
import { jobRouter } from "@/server/routers/job";
import { encryptCredentials, type Credentials } from "@/server/integrations/credentials";
import type { IntegrationProvider } from "@prisma/client";
import { addMember, createOrg, createProject, createUser, type TestUser } from "../helpers/factories";

/** Planning routers mounted under their appRouter names (plus job). */
const planningRouter = router({
  roadmap: roadmapRouter,
  analytics: analyticsRouter,
  outcome: outcomeRouter,
  presentation: presentationRouter,
  handoff: handoffRouter,
  job: jobRouter,
});
const createCaller = createCallerFactory(planningRouter);

export function callerFor(user: TestUser | null, orgId?: string) {
  return createCaller(
    createTestContext({
      user: user ? { id: user.id, clerkId: user.clerkId, email: user.email, name: user.name } : null,
      requestedOrgId: orgId ?? null,
    })
  );
}

export async function runWorker<Q extends QueueName>(def: WorkerDefinition<Q>, payload: unknown, attempt = 1, maxAttempts = 3) {
  return runJob(def, payload, { jobId: `test_${Date.now()}`, attempt, maxAttempts });
}

/** Owner + member + viewer in one org with a project, plus an outsider with their own project. */
export async function setupTeam() {
  const owner = await createUser({ name: "Owner" });
  const member = await createUser({ name: "Member" });
  const viewer = await createUser({ name: "Viewer" });
  const outsider = await createUser({ name: "Outsider" });
  const org = await createOrg(owner);
  await addMember(org.id, member, "MEMBER");
  await addMember(org.id, viewer, "VIEWER");
  const project = await createProject(owner, org.id, "Planning project");
  const outsiderProject = await createProject(outsider, outsider.personalOrgId, "Other project");
  return { owner, member, viewer, outsider, org, project, outsiderProject };
}

export interface SeedTheme {
  name: string;
  description?: string;
  sentiment?: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED";
  /** One citation per entry, from a document created on that date (YYYY-MM-DD). */
  mentions?: Array<{ date: string; quote: string }>;
}

/** A READY synthesis with themes and citations (documents dated per mention). */
export async function seedSynthesis(projectId: string, themes: SeedTheme[]) {
  const synthesis = await prisma.synthesis.create({ data: { projectId, type: "FULL", status: "READY", completedAt: new Date() } });
  const created = [];
  let position = 0;
  for (const t of themes) {
    const theme = await prisma.theme.create({
      data: {
        synthesisId: synthesis.id,
        name: t.name,
        description: t.description ?? `${t.name} description`,
        sentiment: t.sentiment ?? "NEGATIVE",
        confidenceScore: 0.8,
      },
    });
    for (const m of t.mentions ?? []) {
      const doc = await prisma.document.create({
        data: {
          projectId,
          title: `Interview ${m.date}`,
          type: "TRANSCRIPT",
          status: "READY",
          processedText: m.quote,
          createdAt: new Date(`${m.date}T12:00:00Z`),
        },
      });
      const chunk = await prisma.chunk.create({ data: { documentId: doc.id, projectId, position: position++, tokenCount: 10, content: m.quote } });
      await prisma.citation.create({ data: { themeId: theme.id, chunkId: chunk.id, quote: m.quote, relevanceScore: 1 } });
    }
    created.push(theme);
  }
  return { synthesis, themes: created };
}

export async function seedRecommendation(projectId: string, overrides: Partial<{ title: string; status: "DRAFT" | "ACCEPTED" | "REJECTED" | "IMPLEMENTED"; impact: "HIGH" | "MEDIUM" | "LOW"; confidence: number; brief: unknown; evidence: unknown }> = {}) {
  return prisma.recommendation.create({
    data: {
      projectId,
      title: overrides.title ?? "Make CSV exports asynchronous",
      description: "Run large exports in the background and email a link.",
      impact: overrides.impact ?? "HIGH",
      confidence: overrides.confidence ?? 0.8,
      status: overrides.status ?? "ACCEPTED",
      segments: ["Enterprise admins"],
      ...(overrides.brief !== undefined ? { brief: overrides.brief as object } : {}),
      ...(overrides.evidence !== undefined ? { evidence: overrides.evidence as object } : {}),
    },
  });
}

/** A CONNECTED integration with encrypted credentials. */
export async function seedIntegration(orgId: string, userId: string, provider: IntegrationProvider, credentials: Credentials, config: Record<string, unknown> = {}) {
  return prisma.integration.create({
    data: { orgId, userId, provider, status: "CONNECTED", config: config as object, ...encryptCredentials(credentials) },
  });
}

/** A minimal fake for safeFetch responses. */
export function fakeResponse(body: unknown, status = 200) {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    url: "https://example.test",
    body: buf,
    text: () => buf.toString("utf8"),
    json: <T,>() => JSON.parse(buf.toString("utf8")) as T,
  };
}

/** Days from `start` (YYYY-MM-DD) as YYYY-MM-DD strings. */
export function days(start: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Narrow an import response to the synchronous (CSV) result. */
export function expectDone<T extends { mode: string }>(res: T): Extract<T, { mode: "done" }> {
  if (res.mode !== "done") throw new Error(`expected a completed import, got ${res.mode}`);
  return res as Extract<T, { mode: "done" }>;
}

/** Narrow an import response to a queued (background) import. */
export function expectQueued<T extends { mode: string }>(res: T): Extract<T, { mode: "queued" }> {
  if (res.mode !== "queued") throw new Error(`expected a queued import, got ${res.mode}`);
  return res as Extract<T, { mode: "queued" }>;
}
