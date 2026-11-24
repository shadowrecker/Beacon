import { describe, expect, it } from "vitest";
import { decryptJson, decryptString, encryptJson, encryptString, sha256Hex, timingSafeEqualStr } from "@/lib/crypto";
import { resolveUploadMime, sanitizeFilename, sniffMime } from "@/lib/file-types";
import { keyBelongsToProject, projectObjectKey } from "@/lib/storage";

describe("crypto envelopes", () => {
  it("round-trips strings and JSON", () => {
    const { envelope, keyVersion } = encryptString("secret-token");
    expect(keyVersion).toBe(1);
    expect(envelope).not.toContain("secret-token");
    expect(decryptString(envelope)).toBe("secret-token");
    const j = encryptJson({ accessToken: "a", refreshToken: "b" });
    expect(decryptJson(j.envelope)).toEqual({ accessToken: "a", refreshToken: "b" });
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptString("x").envelope).not.toBe(encryptString("x").envelope);
  });

  it("rejects tampered ciphertext", () => {
    const { envelope } = encryptString("hello");
    const parts = envelope.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptString(parts.join("."))).toThrow();
  });

  it("decrypts old key versions after rotation", () => {
    const old = encryptString("rotate-me").envelope;
    const prevKeys = process.env.CREDENTIALS_ENCRYPTION_KEYS;
    const prevVersion = process.env.CREDENTIALS_KEY_VERSION;
    process.env.CREDENTIALS_ENCRYPTION_KEYS = JSON.stringify({
      1: Buffer.alloc(32, 7).toString("base64"),
      2: Buffer.alloc(32, 9).toString("base64"),
    });
    process.env.CREDENTIALS_KEY_VERSION = "2";
    try {
      const fresh = encryptString("new");
      expect(fresh.keyVersion).toBe(2);
      expect(decryptString(old)).toBe("rotate-me");
      expect(decryptString(fresh.envelope)).toBe("new");
    } finally {
      process.env.CREDENTIALS_ENCRYPTION_KEYS = prevKeys;
      process.env.CREDENTIALS_KEY_VERSION = prevVersion;
    }
  });

  it("hashes and compares in constant time", () => {
    expect(sha256Hex("abc")).toHaveLength(64);
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("file type sniffing", () => {
  it("detects binary families by magic bytes", () => {
    expect(sniffMime(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffMime(Buffer.from([0x49, 0x44, 0x33, 0x04]))).toBe("audio/mpeg");
    expect(sniffMime(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]))).toBe("audio/wav");
    expect(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")]))).toBe("audio/mp4");
    expect(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]))).toBe("video/mp4");
    expect(sniffMime(Buffer.from("plain text body"))).toBe("text/plain");
    expect(sniffMime(Buffer.from([0x00, 0x01, 0x02, 0xff]))).toBeNull();
  });

  it("requires content to match the extension", () => {
    expect(resolveUploadMime("notes.md", Buffer.from("# Title"))).toMatchObject({ ok: true, type: { mime: "text/markdown" } });
    expect(resolveUploadMime("data.csv", Buffer.from("a,b\n1,2"))).toMatchObject({ ok: true, type: { mime: "text/csv" } });
    expect(resolveUploadMime("doc.pdf", Buffer.from("%PDF-1.4"))).toMatchObject({ ok: true });
    // HTML disguised as a PDF
    expect(resolveUploadMime("evil.pdf", Buffer.from("<html><script>"))).toMatchObject({ ok: false });
    // Executable disguised as text
    expect(resolveUploadMime("a.txt", Buffer.from([0x4d, 0x5a, 0x00, 0x00]))).toMatchObject({ ok: false });
    expect(resolveUploadMime("page.html", Buffer.from("<html>"))).toMatchObject({ ok: false, reason: "File type is not supported" });
  });

  it("sanitizes filenames and builds scoped keys", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..hidden")).toBe("hidden");
    expect(sanitizeFilename("My Interview (final).pdf")).toBe("My_Interview_final_.pdf");
    const key = projectObjectKey("proj123", "documents", "doc1", "../x.pdf");
    expect(key).toBe("projects/proj123/documents/doc1/x.pdf");
    expect(keyBelongsToProject(key, "proj123")).toBe(true);
    expect(keyBelongsToProject(key, "other")).toBe(false);
    expect(keyBelongsToProject("projects/proj123/../other/x", "proj123")).toBe(false);
    expect(() => projectObjectKey("../x", "documents", "d", "f")).toThrow();
  });
});
