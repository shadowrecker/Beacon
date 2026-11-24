import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { documentWorker } from "@/workers/document-worker";
import { createDocumentFromText } from "@/server/documents/ingest";
import { chunkText, MAX_CHUNK_TOKENS } from "@/server/ai/pipeline/chunker";
import { csvToRows, parseCsv } from "@/server/ai/pipeline/csv";
import { parseSubtitles } from "@/server/ai/pipeline/subtitles";
import { parsePlainText, parseBytes } from "@/server/ai/pipeline/parser";
import { htmlToText, extractTitle } from "@/server/ai/pipeline/html";
import { deepgramTurns } from "@/server/ai/pipeline/transcribe";
import { estimateTokens, locateQuote } from "@/server/ai/utils";
import { jobsFor, storage } from "../helpers/doubles";
import { createProject, createUser } from "../helpers/factories";
import { embeddedChunkCount, eventsOfType, runWorker, uploadFile } from "./helpers";

const INTERVIEW = `Interviewer: Thanks for joining. How do you export reports today?
Dana: Honestly it's painful. The CSV export times out whenever the workspace has more than ten thousand rows, so I end up splitting the date range by hand.
Interviewer: How often does that happen?
Dana: Every Monday. Our leadership review depends on that export, and when it fails I lose most of the morning.
Interviewer: Anything you like about the product?
Dana: The dashboards are great. Sharing a dashboard link with the sales team saves us a lot of back and forth.`;

describe("chunker", () => {
  it("keeps real offsets and never exceeds the token ceiling", () => {
    const sentence = "Customers say the export button is hard to find and the export itself is slow. ";
    const long = sentence.repeat(400) + "x".repeat(20_000) + " " + "word ".repeat(3000);
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(long.slice(c.startOffset, c.endOffset)).toBe(c.content);
      expect(c.tokenCount).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
      expect(estimateTokens(c.content)).toBeLessThanOrEqual(MAX_CHUNK_TOKENS);
    }
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    // Chunks cover the whole text in order.
    expect(chunks[0].startOffset).toBe(0);
    expect(chunks[chunks.length - 1].endOffset).toBe(long.trimEnd().length);
  });

  it("attaches speaker metadata to transcript chunks", () => {
    const parsed = parsePlainText(INTERVIEW);
    const chunks = chunkText(parsed.text, parsed.segments);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.speakers).toEqual(["Interviewer", "Dana"]);
  });

  it("estimates tokens conservatively (≥ chars/4 and ≥ words×1.3)", () => {
    expect(estimateTokens("one two three four")).toBe(Math.ceil(4 * 1.3));
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("parsers", () => {
  it("parses quoted CSV fields, escaped quotes and embedded newlines", () => {
    const csv = 'id,customer,feedback\r\n1,"Acme, Inc.","Export ""times out"" on big files"\r\n2,Globex,"Line one\nline two"\r\n\r\n';
    const { records } = parseCsv(csv);
    expect(records).toEqual([
      ["id", "customer", "feedback"],
      ["1", "Acme, Inc.", 'Export "times out" on big files'],
      ["2", "Globex", "Line one\nline two"],
    ]);
    const { rows } = csvToRows(csv);
    expect(rows[0]).toEqual({ row: 1, text: 'id: 1; customer: Acme, Inc.; feedback: Export "times out" on big files' });
  });

  it("detects semicolon-delimited exports", () => {
    expect(parseCsv("a;b\n1;2").records).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("turns WebVTT and SRT into speaker turns without timestamps", () => {
    const vtt = `WEBVTT

NOTE produced by the call recorder

00:00:01.000 --> 00:00:04.000
<v Alice>We need SSO before we can roll out.</v>

00:00:04.000 --> 00:00:06.500
<v Alice>Our security team insists.</v>

00:00:07.000 --> 00:00:09.000
<v Bob>Understood, it's on the roadmap.</v>`;
    expect(parseSubtitles(vtt)).toEqual([
      { speaker: "Alice", startSec: 1, text: "We need SSO before we can roll out. Our security team insists." },
      { speaker: "Bob", startSec: 7, text: "Understood, it's on the roadmap." },
    ]);
    const srt = `1
00:00:01,000 --> 00:00:02,000
Customer: The invoice page is confusing.

2
00:00:02,500 --> 00:00:04,000
<i>Agent:</i> Let me show you.`;
    const turns = parseSubtitles(srt);
    expect(turns.map((t) => [t.speaker, t.text])).toEqual([
      ["Customer", "The invoice page is confusing."],
      ["Agent", "Let me show you."],
    ]);
  });

  it("parses JSON record exports one record per line", async () => {
    const doc = await parseBytes("application/json", Buffer.from(JSON.stringify([{ ticket: 1, body: "Login loop on Safari" }, { ticket: 2, body: "Refund request" }])));
    expect(doc.text).toBe("ticket: 1; body: Login loop on Safari\nticket: 2; body: Refund request");
    expect(doc.segments.map((s) => s.row)).toEqual([1, 2]);
  });

  it("extracts readable text and title from HTML", () => {
    const html = `<!doctype html><html><head><title>Ignored</title><meta property="og:title" content="Release notes &amp; feedback"><style>p{}</style></head>
<body><nav>Home | Pricing</nav><article><h1>What customers said</h1><p>The new editor is <b>much</b> faster.</p><script>alert(1)</script><ul><li>Fewer clicks</li><li>Better search</li></ul></article><footer>© Example</footer></body></html>`;
    expect(extractTitle(html)).toBe("Release notes & feedback");
    const text = htmlToText(html);
    expect(text).toContain("What customers said");
    expect(text).toContain("The new editor is much faster.");
    expect(text).toContain("- Fewer clicks");
    expect(text).not.toMatch(/alert|Pricing|Example|p\{\}/);
  });

  it("keeps Deepgram diarization as merged speaker turns", () => {
    const turns = deepgramTurns({
      results: {
        utterances: [
          { start: 0.2, end: 2, transcript: "Hi, thanks for the time.", speaker: 0 },
          { start: 2.1, end: 4, transcript: "Happy to help.", speaker: 0 },
          { start: 4.5, end: 7, transcript: "Onboarding took us three weeks.", speaker: 1 },
        ],
      },
    });
    expect(turns).toEqual([
      { speaker: "Speaker 1", startSec: 0, text: "Hi, thanks for the time. Happy to help." },
      { speaker: "Speaker 2", startSec: 5, text: "Onboarding took us three weeks." },
    ]);
  });

  it("locates quotes verbatim, tolerating whitespace, case and smart quotes", () => {
    const content = "She said: \"The export   times out\nevery Monday.\" Then she left.";
    expect(locateQuote(content, "The export times out every Monday")?.text).toBe("The export   times out\nevery Monday");
    expect(locateQuote(content, "“the EXPORT times out every monday”")?.text).toBe("The export   times out\nevery Monday");
    expect(locateQuote(content, "The import times out")).toBeNull();
    expect(locateQuote(content, "She")).toBeNull();
  });
});

describe("document worker", () => {
  async function setup() {
    const user = await createUser();
    const project = await createProject(user);
    return { user, project };
  }

  it.each([
    ["interview.txt", INTERVIEW, "text/plain"],
    ["notes.md", `# Research notes\n\n${INTERVIEW}\n\n## Follow-ups\n\n- Ask about SSO\n- Ask about billing`, "text/markdown"],
    [
      "tickets.csv",
      'id,customer,feedback\n1,"Acme, Inc.","The CSV export times out on large workspaces"\n2,Globex,"Love the dashboards, but SSO is missing"\n3,Initech,"Invoices are confusing; we pay late because of it"\n',
      "text/csv",
    ],
  ])("processes %s end to end and is idempotent on re-run", async (filename, body, mime) => {
    const { user, project } = await setup();
    const documentId = await uploadFile(user, project.id, filename, body);
    const queued = jobsFor(QUEUE.DOCUMENTS);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ documentId });
    expect(queued[0].opts.jobId).toBe(`doc_${documentId}`);

    await runWorker(documentWorker, { documentId });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.status).toBe("READY");
    expect(doc.mimeType).toBe(mime);
    expect(doc.processingCompletedAt).not.toBeNull();
    expect(doc.processedText).toBeTruthy();

    const chunks = await prisma.chunk.findMany({ where: { documentId }, orderBy: { position: "asc" } });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.projectId).toBe(project.id);
      expect(doc.processedText!.slice(c.startOffset!, c.endOffset!)).toBe(c.content);
    }
    expect(await embeddedChunkCount(documentId)).toBe(chunks.length);
    if (mime === "text/csv") expect(chunks[0].metadata).toMatchObject({ rows: [1, 3] });

    const ready = await eventsOfType("document.ready");
    expect(ready).toHaveLength(1);
    expect(ready[0].payload).toMatchObject({ documentId, chunkCount: chunks.length });

    // A retried job replaces the chunks instead of duplicating them.
    await runWorker(documentWorker, { documentId });
    expect(await prisma.chunk.count({ where: { documentId } })).toBe(chunks.length);
    expect(await embeddedChunkCount(documentId)).toBe(chunks.length);
  });

  it("uses existing processedText without reading storage (integration/voice documents)", async () => {
    const { project } = await setup();
    const { documentId } = await createDocumentFromText({
      projectId: project.id,
      title: "Zendesk #42",
      type: "SUPPORT_TICKET",
      source: "INTEGRATION",
      text: "Customer reports the mobile app logs them out every hour. They want a remember-me option.",
    });
    await runWorker(documentWorker, { documentId });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.status).toBe("READY");
    expect(await embeddedChunkCount(documentId)).toBe(1);
  });

  it("moves the document to FAILED with a reason when the file is gone, and emits document.failed", async () => {
    const { user, project } = await setup();
    const documentId = await uploadFile(user, project.id, "gone.txt", "This file will disappear before processing starts.");
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    await storage.delete(doc.storageKey!);

    await expect(runWorker(documentWorker, { documentId })).rejects.toThrow();
    const failed = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toMatch(/missing/i);
    expect(await prisma.chunk.count({ where: { documentId } })).toBe(0);
    const events = await eventsOfType("document.failed");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ documentId });
  });

  it("only marks FAILED on the final attempt for transient errors", async () => {
    const { project } = await setup();
    const { documentId } = await createDocumentFromText({ projectId: project.id, title: "t", type: "NOTE", source: "QUICK_CAPTURE", text: "Some feedback text that is long enough." });
    // Make the embedding provider fail transiently.
    const embeddings = await import("@/server/ai/embeddings");
    embeddings.setEmbeddingProviderForTests({
      async embed() {
        throw new Error("upstream 503");
      },
    });
    try {
      await expect(runWorker(documentWorker, { documentId }, 1, 3)).rejects.toThrow("upstream 503");
      expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).status).toBe("PROCESSING");
      await expect(runWorker(documentWorker, { documentId }, 3, 3)).rejects.toThrow("upstream 503");
      const doc = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
      expect(doc.status).toBe("FAILED");
      expect(doc.errorMessage).toBe("upstream 503");
    } finally {
      const { installTestDoubles } = await import("../helpers/doubles");
      installTestDoubles();
    }
  });
});

describe("audio documents use the shared Deepgram client", () => {
  it("transcribes an uploaded audio file into speaker turns and records usage", async () => {
    const { setDeepgramTransportForTests } = await import("@/server/ai/voice/transcriber");
    const { storage } = await import("../helpers/doubles");
    const { documentWorker } = await import("@/workers/document-worker");
    const { runWorker } = await import("./helpers");
    const { prisma } = await import("@/lib/db");
    const { createProject, createUser } = await import("../helpers/factories");
    const user = await createUser();
    const project = await createProject(user);
    const key = `projects/${project.id}/documents/d1/call.mp3`;
    await storage.put(key, Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]), "audio/mpeg");
    const doc = await prisma.document.create({
      data: { projectId: project.id, title: "Customer call", type: "CALL_RECORDING", source: "UPLOAD", mimeType: "audio/mpeg", storageKey: key, status: "PENDING" },
    });
    process.env.DEEPGRAM_API_KEY = "dg_test";
    let calledUrl = "";
    setDeepgramTransportForTests(async (url) => {
      calledUrl = url;
      const body = {
        metadata: { duration: 42 },
        results: { utterances: [
          { start: 0, end: 3, transcript: "How is onboarding going?", speaker: 0 },
          { start: 3.5, end: 8, transcript: "Connecting Slack took a week.", speaker: 1 },
        ] },
      };
      const buf = Buffer.from(JSON.stringify(body));
      return { status: 200, ok: true, headers: new Headers(), url, body: buf, text: () => buf.toString(), json: <T,>() => body as T };
    });
    try {
      await runWorker(documentWorker, { documentId: doc.id });
    } finally {
      setDeepgramTransportForTests(null);
      delete process.env.DEEPGRAM_API_KEY;
    }
    expect(calledUrl).toContain("api.deepgram.com/v1/listen");
    expect(calledUrl).toContain("diarize=true");
    const ready = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(ready.status).toBe("READY");
    expect(ready.processedText).toContain("Speaker 2");
    const usage = await prisma.tokenUsage.findMany({ where: { orgId: project.orgId, provider: "deepgram" } });
    expect(usage).toHaveLength(1);
    expect(usage[0].inputTokens).toBe(42);
  });
});
