/**
 * Upload allowlist and content sniffing.
 *
 * The MIME type stored on a document (and used as the object's Content-Type) is
 * derived from the file's bytes plus its extension, never from the client.
 */

export type FileCategory = "document" | "audio" | "video";

export interface AllowedType {
  mime: string;
  extensions: string[];
  category: FileCategory;
  maxBytes: number;
}

const MB = 1024 * 1024;

export const ALLOWED_TYPES: AllowedType[] = [
  { mime: "application/pdf", extensions: ["pdf"], category: "document", maxBytes: 50 * MB },
  { mime: "text/plain", extensions: ["txt", "log"], category: "document", maxBytes: 20 * MB },
  { mime: "text/markdown", extensions: ["md", "markdown"], category: "document", maxBytes: 20 * MB },
  { mime: "text/csv", extensions: ["csv"], category: "document", maxBytes: 50 * MB },
  { mime: "text/vtt", extensions: ["vtt"], category: "document", maxBytes: 20 * MB },
  { mime: "application/x-subrip", extensions: ["srt"], category: "document", maxBytes: 20 * MB },
  { mime: "application/json", extensions: ["json"], category: "document", maxBytes: 20 * MB },
  { mime: "audio/mpeg", extensions: ["mp3"], category: "audio", maxBytes: 500 * MB },
  { mime: "audio/wav", extensions: ["wav"], category: "audio", maxBytes: 500 * MB },
  { mime: "audio/mp4", extensions: ["m4a"], category: "audio", maxBytes: 500 * MB },
  { mime: "audio/ogg", extensions: ["ogg", "oga"], category: "audio", maxBytes: 500 * MB },
  { mime: "audio/webm", extensions: ["weba"], category: "audio", maxBytes: 500 * MB },
  { mime: "video/mp4", extensions: ["mp4"], category: "video", maxBytes: 1024 * MB },
  { mime: "video/quicktime", extensions: ["mov"], category: "video", maxBytes: 1024 * MB },
  { mime: "video/webm", extensions: ["webm"], category: "video", maxBytes: 1024 * MB },
];

export function extensionOf(filename: string): string {
  const m = filename.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return m ? m[1] : "";
}

/** The allowlisted type for a filename, or null if the extension is not accepted. */
export function allowedTypeForFilename(filename: string): AllowedType | null {
  const ext = extensionOf(filename);
  return ALLOWED_TYPES.find((t) => t.extensions.includes(ext)) ?? null;
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // A multi-byte sequence may be cut at the sample boundary; retry trimmed.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, sample.length - 4));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Sniff the real type from the first bytes. Returns the canonical MIME, or null
 * when the content does not match any allowed family.
 */
export function sniffMime(head: Buffer): string | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // %PDF
  if (startsWith(head, [0x49, 0x44, 0x33]) || startsWith(head, [0xff, 0xfb]) || startsWith(head, [0xff, 0xf3]) || startsWith(head, [0xff, 0xf2])) {
    return "audio/mpeg";
  }
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x41, 0x56, 0x45], 8)) {
    return "audio/wav";
  }
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm"; // Matroska/WebM
  if (startsWith(head, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = head.subarray(8, 12).toString("ascii");
    if (brand.startsWith("M4A")) return "audio/mp4";
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }
  if (looksLikeText(head)) return "text/plain";
  return null;
}

/**
 * Resolve the final MIME for an upload: the sniffed family must agree with the
 * extension's allowlisted type. Text families are refined by extension (md, csv...).
 */
export function resolveUploadMime(filename: string, head: Buffer): { ok: true; type: AllowedType } | { ok: false; reason: string } {
  const allowed = allowedTypeForFilename(filename);
  if (!allowed) return { ok: false, reason: "File type is not supported" };
  const sniffed = sniffMime(head);
  if (!sniffed) return { ok: false, reason: "File content does not match a supported type" };

  const isTextFamily = (m: string) => m.startsWith("text/") || m === "application/json" || m === "application/x-subrip";
  if (sniffed === "text/plain" && isTextFamily(allowed.mime)) return { ok: true, type: allowed };

  // Container formats legitimately overlap (webm audio vs video, mp4 vs m4a).
  const family = (m: string) => {
    if (m === "audio/webm" || m === "video/webm") return "webm";
    if (m === "audio/mp4" || m === "video/mp4" || m === "video/quicktime") return "mp4";
    return m;
  };
  if (family(sniffed) === family(allowed.mime)) return { ok: true, type: allowed };
  return { ok: false, reason: "File content does not match its extension" };
}

/** Make a filename safe for use inside an object key. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/_+/g, "_")
    .slice(-100);
  return cleaned.length > 0 ? cleaned : "file";
}
