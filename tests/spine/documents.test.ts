import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { QUEUE } from "@/server/jobs/queues";
import { documentRouter } from "@/server/routers/document";
import { jobsFor, storage } from "../helpers/doubles";
import { createProject, createUser } from "../helpers/factories";
import { callerFor, eventsOfType, uploadFile } from "./helpers";

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("upload flow", () => {
  it("issues a server-chosen key inside the project prefix and creates a PENDING row", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const res = await callerFor(user).document.getUploadUrl({ projectId: project.id, filename: "../../etc/Interview notes.md", size: 1200 });
    expect(res.contentType).toBe("text/markdown");
    expect(res.fields.key).toBe(`projects/${project.id}/documents/${res.documentId}/Interview_notes.md`);
    const row = await prisma.document.findUniqueOrThrow({ where: { id: res.documentId } });
    expect(row).toMatchObject({ status: "PENDING", source: "UPLOAD", storageKey: res.fields.key, createdById: user.id });
    expect(jobsFor(QUEUE.DOCUMENTS)).toHaveLength(0);
    // Not yet uploaded: listed as awaiting upload.
    const list = await callerFor(user).document.list({ projectId: project.id });
    expect(list.items[0]).toMatchObject({ id: res.documentId, awaitingUpload: true });
  });

  it("rejects unsupported types and oversized files before creating anything", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const caller = callerFor(user);
    await expect(caller.document.getUploadUrl({ projectId: project.id, filename: "run.exe", size: 10 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.document.getUploadUrl({ projectId: project.id, filename: "big.txt", size: 21 * 1024 * 1024 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.document.count()).toBe(0);
  });

  it("confirms an upload: sniffs the bytes, records size/MIME, queues processing once, emits document.uploaded", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const caller = callerFor(user);
    const presign = await caller.document.getUploadUrl({ projectId: project.id, filename: "roadmap-feedback.pdf", size: PDF_BYTES.length });
    await expect(caller.document.confirmUpload({ projectId: project.id, documentId: presign.documentId, type: "NOTE" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await storage.put(presign.fields.key, PDF_BYTES, presign.contentType);
    const res = await caller.document.confirmUpload({ projectId: project.id, documentId: presign.documentId, type: "NOTE", title: "Roadmap feedback" });
    expect(res).toEqual({ id: presign.documentId, status: "PENDING" });
    const row = await prisma.document.findUniqueOrThrow({ where: { id: presign.documentId } });
    expect(row).toMatchObject({ title: "Roadmap feedback", type: "NOTE", mimeType: "application/pdf", fileSize: PDF_BYTES.length });

    // Double submit is a no-op.
    await caller.document.confirmUpload({ projectId: project.id, documentId: presign.documentId, type: "NOTE" });
    expect(jobsFor(QUEUE.DOCUMENTS)).toHaveLength(1);
    expect(await eventsOfType("document.uploaded")).toHaveLength(1);
  });

  it("rejects spoofed content and removes the object and the row", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const caller = callerFor(user);
    const presign = await caller.document.getUploadUrl({ projectId: project.id, filename: "report.pdf", size: 40 });
    await storage.put(presign.fields.key, Buffer.from("this is plain text pretending to be a pdf"), "application/pdf");
    await expect(caller.document.confirmUpload({ projectId: project.id, documentId: presign.documentId, type: "NOTE" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "File content does not match its extension",
    });
    expect(storage.objects.has(presign.fields.key)).toBe(false);
    expect(await prisma.document.findUnique({ where: { id: presign.documentId } })).toBeNull();

    const bin = await caller.document.getUploadUrl({ projectId: project.id, filename: "notes.txt", size: 8 });
    await storage.put(bin.fields.key, Buffer.from([0x4d, 0x5a, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]), "text/plain");
    await expect(caller.document.confirmUpload({ projectId: project.id, documentId: bin.documentId, type: "NOTE" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(jobsFor(QUEUE.DOCUMENTS)).toHaveLength(0);
  });

  it("never accepts a client-supplied storage location", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const procedures = Object.keys((documentRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
    expect(procedures).not.toContain("create");
    expect(procedures).not.toContain("updateStatus");
    // Unknown fields such as rawUrl/storageKey are stripped by validation.
    const presign = await callerFor(user).document.getUploadUrl({
      projectId: project.id,
      filename: "a.txt",
      size: 5,
      ...({ rawUrl: "/etc/passwd", storageKey: "projects/other/x" } as object),
    });
    expect(presign.fields.key.startsWith(`projects/${project.id}/documents/${presign.documentId}/`)).toBe(true);
  });
});

describe("URL import", () => {
  it("refuses private, loopback and non-http destinations", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const caller = callerFor(user);
    for (const url of ["http://127.0.0.1/admin", "https://169.254.169.254/latest/meta-data", "https://localhost/x", "file:///etc/passwd"]) {
      await expect(caller.document.importUrl({ projectId: project.id, url })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await prisma.document.count()).toBe(0);
  });
});

describe("document detail, retry and delete", () => {
  it("returns metadata without text and paginates chunks by position", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const doc = await prisma.document.create({ data: { projectId: project.id, title: "Long", type: "NOTE", status: "READY", processedText: "secret full text" } });
    await prisma.chunk.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({ documentId: doc.id, projectId: project.id, content: `chunk ${i}`, position: i, tokenCount: 2 })),
    });
    const caller = callerFor(user);
    const detail = await caller.document.getById({ projectId: project.id, id: doc.id });
    expect(detail).toMatchObject({ id: doc.id, chunkCount: 5, status: "READY" });
    expect(JSON.stringify(detail)).not.toContain("secret full text");
    const list = await caller.document.list({ projectId: project.id });
    expect(JSON.stringify(list)).not.toContain("secret full text");

    const p1 = await caller.document.chunks({ projectId: project.id, documentId: doc.id, limit: 2 });
    expect(p1.items.map((c) => c.position)).toEqual([0, 1]);
    expect(p1.nextCursor).toBe(2);
    const fromCited = await caller.document.chunks({ projectId: project.id, documentId: doc.id, limit: 10, cursor: 3 });
    expect(fromCited.items.map((c) => c.content)).toEqual(["chunk 3", "chunk 4"]);
    expect(fromCited.nextCursor).toBeNull();
  });

  it("retries only FAILED documents and re-queues them", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const caller = callerFor(user);
    const id = await uploadFile(user, project.id, "a.txt", "Feedback about onboarding being slow.");
    await expect(caller.document.retry({ projectId: project.id, id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await prisma.document.update({ where: { id }, data: { status: "FAILED", errorMessage: "boom" } });
    await caller.document.retry({ projectId: project.id, id });
    const row = await prisma.document.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "PENDING", errorMessage: null });
    expect(jobsFor(QUEUE.DOCUMENTS)).toHaveLength(2);
  });

  it("deletes the row, its chunks and its stored object", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const id = await uploadFile(user, project.id, "a.txt", "Feedback about onboarding being slow.");
    const { storageKey } = await prisma.document.findUniqueOrThrow({ where: { id } });
    await prisma.chunk.create({ data: { documentId: id, projectId: project.id, content: "x", position: 0, tokenCount: 1 } });
    await callerFor(user).document.delete({ projectId: project.id, id });
    expect(await prisma.document.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.chunk.count({ where: { documentId: id } })).toBe(0);
    expect(storage.objects.has(storageKey!)).toBe(false);
  });

  it("issues download links only for the document's own object", async () => {
    const user = await createUser();
    const project = await createProject(user);
    const id = await uploadFile(user, project.id, "a.txt", "Feedback about onboarding being slow.");
    const { url } = await callerFor(user).document.getDownloadUrl({ projectId: project.id, id });
    expect(url).toContain(encodeURIComponent(`projects/${project.id}/documents/${id}/`));
  });
});
