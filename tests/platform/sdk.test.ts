/**
 * Runs the published SDK against the real REST route handlers in-process (a
 * fetch shim calls the Next.js route functions with Request objects), for every
 * SDK method, and checks each response against the route's response schema so
 * the SDK, the router and the OpenAPI document cannot drift apart.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { prisma } from "@/lib/db";
import { ROUTES } from "@/server/api/routes";
import { GET, POST, PATCH, DELETE } from "@/app/api/v1/[...path]/route";
import {
  BeaconAuthenticationError,
  BeaconClient,
  BeaconConflictError,
  BeaconNotFoundError,
  BeaconPermissionError,
  BeaconRateLimitError,
  BeaconValidationError,
  type Project,
} from "../../packages/sdk/src/index";
import { callerFor } from "../helpers/caller";
import { createTenant, type Tenant } from "./helpers";

const BASE = "https://beacon.test/api/v1";
const HANDLERS: Record<string, (req: Request) => Promise<Response>> = { GET, POST, PATCH, DELETE };

const shim: typeof fetch = async (input, init) => {
  const req = new Request(input as string, init);
  const handler = HANDLERS[req.method];
  if (!handler) return new Response(null, { status: 405 });
  return handler(req);
};

/** SDK method for each REST operation. */
const SDK_METHOD_FOR: Record<string, keyof BeaconClient> = {
  listProjects: "listProjects",
  createProject: "createProject",
  getProject: "getProject",
  updateProject: "updateProject",
  listDocuments: "listDocuments",
  createDocument: "createDocument",
  getDocument: "getDocument",
  deleteDocument: "deleteDocument",
  listSyntheses: "listSyntheses",
  runSynthesis: "runSynthesis",
  getSynthesis: "getSynthesis",
  listRecommendations: "listRecommendations",
  listVoiceInsights: "getVoiceInsights",
  listVoiceRecordings: "listVoiceRecordings",
  getVoiceRecording: "getVoiceRecording",
};

const ALL_SCOPES = [
  "projects:read",
  "projects:write",
  "documents:read",
  "documents:write",
  "synthesis:read",
  "synthesis:write",
  "recommendations:read",
  "voice:read",
] as const;

function conforms(operationId: string, value: unknown): void {
  const route = ROUTES.find((r) => r.operationId === operationId);
  expect(route, operationId).toBeDefined();
  (route!.response as z.ZodType).parse(value);
}

let a: Tenant;
let b: Tenant;
let sdk: BeaconClient;
let fixtures: { documentId: string; synthesisId: string; recordingId: string };

beforeEach(async () => {
  a = await createTenant("Acme");
  b = await createTenant("Globex");
  const { key } = await callerFor(a.owner, a.orgId).apiKey.create({ name: "sdk", scopes: [...ALL_SCOPES] });
  sdk = new BeaconClient({ apiKey: key, baseUrl: BASE, fetch: shim });

  const doc = await prisma.document.create({
    data: { projectId: a.projectId, title: "Interview 1", type: "TRANSCRIPT", status: "READY", processedText: "SSO please." },
  });
  const synthesis = await prisma.synthesis.create({
    data: {
      projectId: a.projectId,
      type: "FULL",
      status: "READY",
      completedAt: new Date(),
      themes: { create: [{ name: "SSO", description: "Enterprise buyers need SSO", sentiment: "NEGATIVE", confidenceScore: 0.9 }] },
    },
  });
  await prisma.recommendation.create({
    data: { projectId: a.projectId, synthesisId: synthesis.id, title: "Ship SSO", description: "SAML first", impact: "HIGH", confidence: 0.8, segments: ["enterprise"] },
  });
  const recording = await prisma.voiceRecording.create({
    data: {
      projectId: a.projectId,
      userId: a.owner.id,
      title: "Customer call",
      duration: 125,
      audioKey: `projects/${a.projectId}/voice/r1/call.webm`,
      recordedAt: new Date(),
      status: "READY",
      insight: { create: { summary: "Wants SSO", keyPoints: ["SSO"], painPoints: ["Login"], actionItems: [], sentimentScore: -0.2, themes: ["auth"] } },
    },
  });
  fixtures = { documentId: doc.id, synthesisId: synthesis.id, recordingId: recording.id };
});

describe("SDK against the in-process REST API", () => {
  it("has a method for every REST operation", () => {
    for (const route of ROUTES) {
      const method = SDK_METHOD_FOR[route.operationId];
      expect(method, route.operationId).toBeDefined();
      expect(typeof (BeaconClient.prototype as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });

  it("projects: list, create, get, update and paginate", async () => {
    const list = await sdk.listProjects();
    conforms("listProjects", list);
    expect(list.data.map((p) => p.id)).toEqual([a.projectId]);
    expect(list.data[0].counts).toEqual({ documents: 1, syntheses: 1, recommendations: 1 });

    const created = await sdk.createProject({ name: "SDK project", description: "made by the SDK" });
    conforms("createProject", created);
    const fetched = await sdk.getProject(created.data.id);
    conforms("getProject", fetched);
    expect(fetched.data.name).toBe("SDK project");
    const updated = await sdk.updateProject(created.data.id, { name: "Renamed" });
    conforms("updateProject", updated);
    expect(updated.data.name).toBe("Renamed");

    const all: Project[] = [];
    for await (const p of sdk.paginate((cursor) => sdk.listProjects({ limit: 1, cursor }))) all.push(p);
    expect(all.map((p) => p.id).sort()).toEqual([a.projectId, created.data.id].sort());
  });

  it("documents: list, create, get and delete", async () => {
    const list = await sdk.listDocuments(a.projectId, { status: "READY" });
    conforms("listDocuments", list);
    expect(list.data.map((d) => d.id)).toEqual([fixtures.documentId]);
    const created = await sdk.createDocument(a.projectId, { title: "Ticket", text: "The export is broken.", type: "SUPPORT_TICKET" });
    conforms("createDocument", created);
    expect(created.data.status).toBe("PENDING");
    const inFlight = await sdk.listDocuments(a.projectId, { status: ["PENDING", "PROCESSING"] });
    conforms("listDocuments", inFlight);
    expect(inFlight.data.map((d) => d.id)).toEqual([created.data.id]);
    const got = await sdk.getDocument(a.projectId, created.data.id);
    conforms("getDocument", got);
    expect(got.data.characterCount).toBe("The export is broken.".length);
    const deleted = await sdk.deleteDocument(a.projectId, created.data.id);
    conforms("deleteDocument", deleted);
    await expect(sdk.getDocument(a.projectId, created.data.id)).rejects.toBeInstanceOf(BeaconNotFoundError);
  });

  it("syntheses: list, get and run", async () => {
    const list = await sdk.listSyntheses(a.projectId);
    conforms("listSyntheses", list);
    expect(list.data[0]).toMatchObject({ id: fixtures.synthesisId, themeCount: 1 });
    const detail = await sdk.getSynthesis(a.projectId, fixtures.synthesisId);
    conforms("getSynthesis", detail);
    expect(detail.data.themes[0]).toMatchObject({ name: "SSO", sentiment: "NEGATIVE" });
    const run = await sdk.runSynthesis(a.projectId, { type: "THEMES" });
    conforms("runSynthesis", run);
    expect(run.data.status).toBe("PENDING");
    await expect(sdk.runSynthesis(a.projectId)).rejects.toBeInstanceOf(BeaconConflictError);
  });

  it("recommendations and voice", async () => {
    const recs = await sdk.listRecommendations(a.projectId, { status: "DRAFT" });
    conforms("listRecommendations", recs);
    expect(recs.data[0]).toMatchObject({ title: "Ship SSO", hasBrief: false });

    const recordings = await sdk.listVoiceRecordings({ projectId: a.projectId });
    conforms("listVoiceRecordings", recordings);
    expect(recordings.data.map((r) => r.id)).toEqual([fixtures.recordingId]);
    const recording = await sdk.getVoiceRecording(fixtures.recordingId);
    conforms("getVoiceRecording", recording);
    expect(recording.data.insight?.summary).toBe("Wants SSO");
    const insights = await sdk.getVoiceInsights(a.projectId);
    conforms("listVoiceInsights", insights);
    expect(insights.data[0].themes).toEqual(["auth"]);
  });

  it("throws typed errors", async () => {
    await expect(sdk.getProject(b.projectId)).rejects.toBeInstanceOf(BeaconNotFoundError);
    const err = await sdk.createProject({ name: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BeaconValidationError);
    expect((err as BeaconValidationError).details[0].path).toBe("name");

    const limited = await callerFor(a.owner, a.orgId).apiKey.create({ name: "ro", scopes: ["voice:read"], rateLimit: 1 });
    const ro = new BeaconClient({ apiKey: limited.key, baseUrl: BASE, fetch: shim });
    await expect(ro.listProjects()).rejects.toBeInstanceOf(BeaconPermissionError);
    const rate = await ro.listVoiceRecordings().catch((e: unknown) => e);
    expect(rate).toBeInstanceOf(BeaconRateLimitError);
    expect((rate as BeaconRateLimitError).retryAfterSeconds).toBeGreaterThan(0);

    await callerFor(a.owner, a.orgId).apiKey.revoke({ id: limited.id });
    await expect(ro.listVoiceRecordings()).rejects.toBeInstanceOf(BeaconAuthenticationError);
    expect(() => new BeaconClient({ apiKey: "bk_short", fetch: shim })).toThrow(/Invalid API key/);
  });
});
