import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import type { SafeFetchOptions } from "@/lib/safe-fetch";
import { QUEUE } from "@/server/jobs/queues";
import { setDeepgramTransportForTests } from "@/server/ai/voice/transcriber";
import { voiceWorker } from "@/workers/voice-worker";
import { jobsFor, scriptLLM, storage } from "../helpers/doubles";
import { addMember, createOrg, createProject, createUser } from "../helpers/factories";
import { callerFor, fakeResponse, runWorker } from "./helpers";

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), Buffer.alloc(2048, 7)]);

const DEEPGRAM_RESPONSE = {
  metadata: { request_id: "req-1", duration: 42.4, channels: 1 },
  results: {
    channels: [{ alternatives: [{ transcript: "Thanks for joining. Our biggest problem is exporting reports. Got it.", confidence: 0.98 }] }],
    utterances: [
      { start: 0.1, end: 1.5, transcript: "Thanks for joining.", speaker: 0, confidence: 0.99 },
      { start: 1.8, end: 5.2, transcript: "Our biggest problem is exporting reports.", speaker: 1, confidence: 0.97 },
      { start: 5.3, end: 6.0, transcript: "It takes forever.", speaker: 1, confidence: 0.97 },
      { start: 6.4, end: 7.0, transcript: "Got it.", speaker: 0, confidence: 0.99 },
    ],
  },
};

const ANALYSIS = {
  summary: "The customer struggles with slow report exports.",
  keyPoints: ["Exports are slow"],
  painPoints: ["Exporting reports takes forever"],
  actionItems: ["Follow up on export performance"],
  questions: [],
  sentimentScore: -0.4,
  themes: ["Report exports"],
  suggestedFollowUps: ["Which report formats matter most?"],
};

let deepgramCalls: Array<{ url: string; opts: SafeFetchOptions }> = [];

beforeEach(() => {
  process.env.DEEPGRAM_API_KEY = "dg-test-key";
  deepgramCalls = [];
  setDeepgramTransportForTests(async (url, opts) => {
    deepgramCalls.push({ url, opts });
    return fakeResponse(200, DEEPGRAM_RESPONSE);
  });
  scriptLLM("voice.analyze", () => ANALYSIS);
});
afterEach(() => setDeepgramTransportForTests(null));

async function workspace() {
  const owner = await createUser();
  const org = await createOrg(owner);
  const project = await createProject(owner, org.id);
  return { owner, org, project };
}

/** createRecording → simulate the browser's presigned POST → finalize. */
async function uploadedRecording(user: Awaited<ReturnType<typeof createUser>>, projectId: string, body: Buffer = WEBM) {
  const caller = callerFor(user);
  const created = await caller.voice.createRecording({ projectId, mimeType: "audio/webm;codecs=opus", durationSec: 42, title: "Acme call" });
  await storage.put(created.upload.fields.key, body, created.upload.contentType);
  return created;
}

describe("voice.createRecording", () => {
  it("generates the storage key server-side under the project prefix", async () => {
    const { owner, project } = await workspace();
    const res = await callerFor(owner).voice.createRecording({ projectId: project.id, mimeType: "audio/mp4", durationSec: 3 });
    const rec = await prisma.voiceRecording.findUniqueOrThrow({ where: { id: res.recordingId } });
    expect(rec.audioKey).toBe(`projects/${project.id}/voice/${res.recordingId}/recording.m4a`);
    expect(res.upload.fields.key).toBe(rec.audioKey);
    expect(rec).toMatchObject({ status: "UPLOADING", mimeType: "audio/mp4", userId: owner.id, projectId: project.id });
    // Inputs that try to choose a location are rejected or ignored by the schema.
    const caller = callerFor(owner);
    await expect(caller.voice.createRecording({ projectId: project.id, mimeType: "text/html", durationSec: 3 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.voice.createRecording({ projectId: project.id, mimeType: "audio/webm", durationSec: 0 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const sneaky = await caller.voice.createRecording({ projectId: project.id, mimeType: "audio/webm", durationSec: 2, audioKey: "projects/other/voice/x/evil.weba", audioUrl: "http://169.254.169.254/" } as never);
    expect((await prisma.voiceRecording.findUniqueOrThrow({ where: { id: sneaky.recordingId } })).audioKey).toMatch(new RegExp(`^projects/${project.id}/voice/${sneaky.recordingId}/`));
  });

  it("requires write access to the project", async () => {
    const { org, project } = await workspace();
    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    const outsider = await createUser();
    await expect(callerFor(viewer).voice.createRecording({ projectId: project.id, mimeType: "audio/webm", durationSec: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(outsider).voice.createRecording({ projectId: project.id, mimeType: "audio/webm", durationSec: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.voiceRecording.count()).toBe(0);
  });
});

describe("voice.finalizeRecording", () => {
  it("checks the upload exists and its bytes are really audio before queueing", async () => {
    const { owner, project } = await workspace();
    const caller = callerFor(owner);
    const created = await caller.voice.createRecording({ projectId: project.id, mimeType: "audio/webm", durationSec: 5 });
    await expect(caller.voice.finalizeRecording({ id: created.recordingId })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await storage.put(created.upload.fields.key, Buffer.from("<html><script>alert(1)</script></html>"), "audio/webm");
    await expect(caller.voice.finalizeRecording({ id: created.recordingId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await storage.head(created.upload.fields.key)).toBeNull();
    expect(await prisma.voiceRecording.findUniqueOrThrow({ where: { id: created.recordingId } })).toMatchObject({ status: "FAILED" });
    expect(jobsFor(QUEUE.VOICE)).toHaveLength(0);

    const good = await uploadedRecording(owner, project.id);
    const res = await caller.voice.finalizeRecording({ id: good.recordingId });
    expect(res.status).toBe("TRANSCRIBING");
    expect(jobsFor(QUEUE.VOICE).map((j) => j.payload)).toEqual([{ recordingId: good.recordingId }]);
    // Finalizing twice is a no-op.
    await caller.voice.finalizeRecording({ id: good.recordingId });
    expect(jobsFor(QUEUE.VOICE)).toHaveLength(1);
  });

  it("only the recorder can finalize; outsiders get NOT_FOUND", async () => {
    const { owner, org, project } = await workspace();
    const member = await createUser();
    await addMember(org.id, member, "MEMBER");
    const outsider = await createUser();
    const rec = await uploadedRecording(owner, project.id);
    await expect(callerFor(member).voice.finalizeRecording({ id: rec.recordingId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(outsider).voice.finalizeRecording({ id: rec.recordingId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("voice worker", () => {
  it("transcribes with diarization, creates a document and insights, and reaches READY", async () => {
    const { owner, project } = await workspace();
    const rec = await uploadedRecording(owner, project.id);
    await callerFor(owner).voice.finalizeRecording({ id: rec.recordingId });
    await runWorker(voiceWorker, { recordingId: rec.recordingId });

    expect(deepgramCalls).toHaveLength(1);
    const url = new URL(deepgramCalls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("diarize")).toBe("true");
    expect(url.searchParams.get("utterances")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(deepgramCalls[0].opts.headers?.authorization).toBe("Token dg-test-key");
    expect(deepgramCalls[0].opts.timeoutMs).toBeGreaterThan(0);

    const done = await prisma.voiceRecording.findUniqueOrThrow({ where: { id: rec.recordingId }, include: { insight: true } });
    expect(done.status).toBe("READY");
    expect(done.errorMessage).toBeNull();
    expect(done.transcriptText).toBe(
      "Speaker 1: Thanks for joining.\n\nSpeaker 2: Our biggest problem is exporting reports. It takes forever.\n\nSpeaker 1: Got it."
    );
    expect(done.transcriptSegments).toEqual([
      { speaker: 0, start: 0.1, end: 1.5, text: "Thanks for joining." },
      { speaker: 1, start: 1.8, end: 6.0, text: "Our biggest problem is exporting reports. It takes forever." },
      { speaker: 0, start: 6.4, end: 7.0, text: "Got it." },
    ]);
    expect(done.duration).toBe(42);
    expect(done.insight).toMatchObject({ summary: ANALYSIS.summary, sentimentScore: -0.4, themes: ["Report exports"] });

    const doc = await prisma.document.findUniqueOrThrow({ where: { id: done.documentId! } });
    expect(doc).toMatchObject({ projectId: project.id, source: "VOICE", type: "CALL_RECORDING", title: "Acme call", processedText: done.transcriptText });
    expect(jobsFor(QUEUE.DOCUMENTS).map((j) => j.payload)).toContainEqual({ documentId: doc.id });
    const ready = await prisma.domainEvent.findMany({ where: { type: "voice.ready" } });
    expect(ready.map((e) => e.payload)).toEqual([{ recordingId: rec.recordingId, documentId: doc.id }]);
  });

  it("is idempotent: a retry after a crash reuses the transcript and the document", async () => {
    const { owner, project } = await workspace();
    const rec = await uploadedRecording(owner, project.id);
    await callerFor(owner).voice.finalizeRecording({ id: rec.recordingId });
    await runWorker(voiceWorker, { recordingId: rec.recordingId });
    const first = await prisma.voiceRecording.findUniqueOrThrow({ where: { id: rec.recordingId } });

    // Simulate a crash right after the document was created but before it was linked.
    await prisma.voiceRecording.update({ where: { id: rec.recordingId }, data: { status: "ANALYZING", documentId: null } });
    await runWorker(voiceWorker, { recordingId: rec.recordingId }, 2, 3);
    const again = await prisma.voiceRecording.findUniqueOrThrow({ where: { id: rec.recordingId } });
    expect(again.documentId).toBe(first.documentId);
    expect(await prisma.document.count({ where: { projectId: project.id, source: "VOICE" } })).toBe(1);
    expect(await prisma.voiceInsight.count()).toBe(1);
    expect(deepgramCalls).toHaveLength(1); // transcript not requested again

    // Re-running a READY recording does nothing.
    await runWorker(voiceWorker, { recordingId: rec.recordingId });
    expect(await prisma.domainEvent.count({ where: { type: "voice.ready" } })).toBe(2);
  });

  it("fails with a clear message when Deepgram rejects the request", async () => {
    const { owner, project } = await workspace();
    setDeepgramTransportForTests(async () => fakeResponse(401, { err_code: "INVALID_AUTH" }));
    const rec = await uploadedRecording(owner, project.id);
    await callerFor(owner).voice.finalizeRecording({ id: rec.recordingId });
    await expect(runWorker(voiceWorker, { recordingId: rec.recordingId })).rejects.toThrow();
    expect(await prisma.voiceRecording.findUniqueOrThrow({ where: { id: rec.recordingId } })).toMatchObject({
      status: "FAILED",
      errorMessage: expect.stringMatching(/Deepgram API key was rejected/),
      documentId: null,
    });
  });

  it("keeps the transcript document when only the analysis fails", async () => {
    const { owner, project } = await workspace();
    scriptLLM("voice.analyze", () => ({ summary: 42 }));
    const rec = await uploadedRecording(owner, project.id);
    await callerFor(owner).voice.finalizeRecording({ id: rec.recordingId });
    await runWorker(voiceWorker, { recordingId: rec.recordingId }, 3, 3).catch(() => undefined);
    const after = await prisma.voiceRecording.findUniqueOrThrow({ where: { id: rec.recordingId } });
    expect(after.status).toBe("READY");
    expect(after.documentId).not.toBeNull();
    expect(after.errorMessage).toMatch(/insights couldn't be generated/);
  });
});

describe("voice router reads and deletes", () => {
  it("lists, reads and deletes with project access checks; delete removes object and rows", async () => {
    const { owner, org, project } = await workspace();
    const member = await createUser();
    const viewer = await createUser();
    await addMember(org.id, member, "MEMBER");
    await addMember(org.id, viewer, "VIEWER");
    const outsider = await createUser();
    const rec = await uploadedRecording(owner, project.id);
    await callerFor(owner).voice.finalizeRecording({ id: rec.recordingId });
    await runWorker(voiceWorker, { recordingId: rec.recordingId });
    const key = rec.upload.fields.key;

    expect((await callerFor(viewer, org.id).voice.list({ projectId: project.id })).items).toHaveLength(1);
    expect((await callerFor(owner, org.id).voice.list({ mine: true })).items[0]).toMatchObject({ id: rec.recordingId, isMine: true });
    expect((await callerFor(viewer, org.id).voice.get({ id: rec.recordingId })).segments).toHaveLength(3);
    expect((await callerFor(viewer, org.id).voice.getInsights({ projectId: project.id })).items).toHaveLength(1);
    expect((await callerFor(viewer).voice.getAudioUrl({ id: rec.recordingId })).url).toContain(encodeURIComponent(key));

    await expect(callerFor(outsider).voice.get({ id: rec.recordingId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).voice.getAudioUrl({ id: rec.recordingId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).voice.getInsights({ projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider, org.id).voice.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(outsider).voice.deleteRecording({ id: rec.recordingId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(viewer).voice.deleteRecording({ id: rec.recordingId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(member).voice.deleteRecording({ id: rec.recordingId })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const docId = (await prisma.voiceRecording.findUniqueOrThrow({ where: { id: rec.recordingId } })).documentId!;
    await callerFor(owner).voice.deleteRecording({ id: rec.recordingId });
    expect(await storage.head(key)).toBeNull();
    expect(await prisma.voiceRecording.count()).toBe(0);
    expect(await prisma.voiceInsight.count()).toBe(0);
    expect(await prisma.document.findUnique({ where: { id: docId } })).toBeNull();
  });
});

describe("quick capture", () => {
  it("creates a document in the project, or files it later via syncToProject", async () => {
    const { owner, org, project } = await workspace();
    const viewer = await createUser();
    await addMember(org.id, viewer, "VIEWER");
    const caller = callerFor(owner);

    const direct = await caller.voice.quickCapture({ projectId: project.id, type: "QUICK_THOUGHT", content: "Customers keep asking for SSO" });
    expect(direct.documentId).not.toBeNull();
    expect(await prisma.document.findUniqueOrThrow({ where: { id: direct.documentId! } })).toMatchObject({ source: "QUICK_CAPTURE", projectId: project.id });

    const inbox = await caller.voice.quickCapture({ type: "CALL_HIGHLIGHT", content: "Renewal at risk: pricing" });
    expect(inbox.documentId).toBeNull();
    const listed = await caller.voice.listQuickCaptures({});
    expect(listed.items.map((c) => c.syncedToProject).sort()).toEqual([false, true]);

    await expect(callerFor(viewer).voice.syncToProject({ captureId: inbox.id, projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const synced = await caller.voice.syncToProject({ captureId: inbox.id, projectId: project.id });
    expect(synced.documentId).toBeTruthy();
    await expect(caller.voice.syncToProject({ captureId: inbox.id, projectId: project.id })).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(callerFor(viewer).voice.quickCapture({ projectId: project.id, type: "QUICK_THOUGHT", content: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const outsider = await createUser();
    const mine = await callerFor(outsider).voice.quickCapture({ type: "QUICK_THOUGHT", content: "mine" });
    await expect(callerFor(outsider).voice.syncToProject({ captureId: mine.id, projectId: project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
