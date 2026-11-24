/**
 * Object storage: one interface, three drivers.
 *
 * - "s3": AWS S3 / Cloudflare R2 / MinIO (production). Private bucket; access is
 *   only via short-lived presigned POST (upload) and GET (download) URLs.
 * - "local": files under LOCAL_STORAGE_DIR, with HMAC-signed URLs served by
 *   /api/storage/local. Development and E2E only; refused in production.
 * - memory: tests (installed with setStorageDriverForTests).
 *
 * Keys are always generated server-side (see projectObjectKey); the client never
 * chooses where an object lives or what bucket is read.
 */
import { mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { hmacSha256Hex, timingSafeEqualStr } from "./crypto";
import { sanitizeFilename } from "./file-types";

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  key: string;
  expiresAt: string;
}

export interface ObjectHead {
  size: number;
  contentType?: string;
}

export interface StorageDriver {
  createUpload(input: { key: string; contentType: string; maxBytes: number; expiresInSec?: number }): Promise<PresignedUpload>;
  head(key: string): Promise<ObjectHead | null>;
  get(key: string, opts?: { maxBytes?: number; range?: [number, number] }): Promise<Buffer>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  presignGet(key: string, opts?: { expiresInSec?: number; downloadName?: string }): Promise<string>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

export class StorageError extends Error {
  constructor(message: string, public readonly code: "NOT_FOUND" | "TOO_LARGE" | "CONFIG" | "INVALID") {
    super(message);
    this.name = "StorageError";
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type ObjectKind = "documents" | "voice" | "presentations" | "exports";

/** projects/{projectId}/{kind}/{id}/{sanitized filename} */
export function projectObjectKey(projectId: string, kind: ObjectKind, id: string, filename: string): string {
  if (!/^[a-z0-9]+$/i.test(projectId) || !/^[a-z0-9_-]+$/i.test(id)) {
    throw new StorageError("Invalid key component", "INVALID");
  }
  return `projects/${projectId}/${kind}/${id}/${sanitizeFilename(filename)}`;
}

export function projectPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

/** True when `key` is inside the project's prefix (defense in depth for reads). */
export function keyBelongsToProject(key: string, projectId: string): boolean {
  return key.startsWith(projectPrefix(projectId)) && !key.includes("..");
}

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------

class S3Driver implements StorageDriver {
  private client: S3Client;
  constructor(private bucket: string) {
    this.client = new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials:
        process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  async createUpload({ key, contentType, maxBytes, expiresInSec = 900 }: { key: string; contentType: string; maxBytes: number; expiresInSec?: number }) {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", 1, maxBytes],
        ["eq", "$Content-Type", contentType],
      ],
      Fields: { "Content-Type": contentType },
      Expires: expiresInSec,
    });
    return { url, fields, key, expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString() };
  }

  async head(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }

  async get(key: string, opts: { maxBytes?: number; range?: [number, number] } = {}) {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: opts.range ? `bytes=${opts.range[0]}-${opts.range[1]}` : undefined,
      })
    );
    if (opts.maxBytes && (res.ContentLength ?? 0) > opts.maxBytes) {
      throw new StorageError("Object exceeds size limit", "TOO_LARGE");
    }
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })
    );
  }

  async presignGet(key: string, opts: { expiresInSec?: number; downloadName?: string } = {}) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: opts.downloadName
          ? `attachment; filename="${sanitizeFilename(opts.downloadName)}"`
          : "attachment",
      }),
      { expiresIn: opts.expiresInSec ?? 300 }
    );
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string) {
    if (!prefix.startsWith("projects/") || prefix.length < "projects/x/".length) {
      throw new StorageError("Refusing to delete an unscoped prefix", "INVALID");
    }
    let deleted = 0;
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      );
      const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } })
        );
        deleted += keys.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

// ---------------------------------------------------------------------------
// Local driver (dev/E2E)
// ---------------------------------------------------------------------------

function localSecret(): string {
  return process.env.STORAGE_SIGNING_SECRET ?? "beacon-local-storage-dev-secret";
}

export function signLocal(parts: string[]): string {
  return hmacSha256Hex(localSecret(), parts.join("|"));
}

export function verifyLocalSignature(parts: string[], sig: string): boolean {
  return timingSafeEqualStr(signLocal(parts), sig);
}

class LocalDriver implements StorageDriver {
  constructor(private root: string, private appUrl: string) {}

  private filePath(key: string): string {
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) {
      throw new StorageError("Invalid key", "INVALID");
    }
    return resolved;
  }

  async createUpload({ key, contentType, maxBytes, expiresInSec = 900 }: { key: string; contentType: string; maxBytes: number; expiresInSec?: number }) {
    const exp = String(Math.floor(Date.now() / 1000) + expiresInSec);
    const sig = signLocal(["upload", key, contentType, String(maxBytes), exp]);
    return {
      url: `${this.appUrl}/api/storage/local`,
      fields: { key, "Content-Type": contentType, maxBytes: String(maxBytes), exp, sig },
      key,
      expiresAt: new Date(Number(exp) * 1000).toISOString(),
    };
  }

  async head(key: string) {
    try {
      const s = await stat(this.filePath(key));
      let contentType: string | undefined;
      try {
        contentType = (await readFile(this.filePath(key) + ".meta", "utf8")).trim();
      } catch {
        contentType = undefined;
      }
      return { size: s.size, contentType };
    } catch {
      return null;
    }
  }

  async get(key: string, opts: { maxBytes?: number; range?: [number, number] } = {}) {
    const head = await this.head(key);
    if (!head) throw new StorageError("Object not found", "NOT_FOUND");
    if (opts.maxBytes && head.size > opts.maxBytes) throw new StorageError("Object exceeds size limit", "TOO_LARGE");
    const buf = await readFile(this.filePath(key));
    return opts.range ? buf.subarray(opts.range[0], opts.range[1] + 1) : buf;
  }

  async put(key: string, body: Buffer, contentType: string) {
    const p = this.filePath(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
    await writeFile(p + ".meta", contentType);
  }

  async presignGet(key: string, opts: { expiresInSec?: number; downloadName?: string } = {}) {
    const exp = String(Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 300));
    const name = opts.downloadName ? sanitizeFilename(opts.downloadName) : "";
    const sig = signLocal(["get", key, exp, name]);
    const qs = new URLSearchParams({ key, exp, sig, ...(name ? { name } : {}) });
    return `${this.appUrl}/api/storage/local?${qs.toString()}`;
  }

  async delete(key: string) {
    await rm(this.filePath(key), { force: true });
    await rm(this.filePath(key) + ".meta", { force: true });
  }

  async deletePrefix(prefix: string) {
    if (!prefix.startsWith("projects/")) throw new StorageError("Refusing to delete an unscoped prefix", "INVALID");
    const dir = this.filePath(prefix.replace(/\/$/, "") + "/.keep").replace(/\/\.keep$/, "");
    let count = 0;
    try {
      const walk = async (d: string): Promise<void> => {
        for (const entry of await readdir(d, { withFileTypes: true })) {
          if (entry.isDirectory()) await walk(path.join(d, entry.name));
          else if (!entry.name.endsWith(".meta")) count++;
        }
      };
      await walk(dir);
      await rm(dir, { recursive: true, force: true });
    } catch {
      return 0;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Memory driver (tests)
// ---------------------------------------------------------------------------

export class MemoryStorageDriver implements StorageDriver {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async createUpload({ key, contentType, maxBytes }: { key: string; contentType: string; maxBytes: number }) {
    return {
      url: "memory://upload",
      fields: { key, "Content-Type": contentType, maxBytes: String(maxBytes) },
      key,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    };
  }
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }
  async get(key: string, opts: { maxBytes?: number; range?: [number, number] } = {}) {
    const o = this.objects.get(key);
    if (!o) throw new StorageError("Object not found", "NOT_FOUND");
    if (opts.maxBytes && o.body.length > opts.maxBytes) throw new StorageError("Object exceeds size limit", "TOO_LARGE");
    return opts.range ? o.body.subarray(opts.range[0], opts.range[1] + 1) : o.body;
  }
  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
  }
  async presignGet(key: string) {
    return `memory://get/${encodeURIComponent(key)}`;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deletePrefix(prefix: string) {
    let n = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key);
        n++;
      }
    }
    return n;
  }
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (driver) return driver;
  const kind = process.env.STORAGE_DRIVER ?? "s3";
  if (kind === "local") {
    if (process.env.NODE_ENV === "production") {
      throw new StorageError("The local storage driver is not allowed in production", "CONFIG");
    }
    driver = new LocalDriver(
      path.resolve(process.env.LOCAL_STORAGE_DIR ?? ".devdata/storage"),
      process.env.APP_URL ?? "http://localhost:3000"
    );
  } else {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new StorageError("S3_BUCKET is not configured", "CONFIG");
    driver = new S3Driver(bucket);
  }
  return driver;
}

export function setStorageDriverForTests(d: StorageDriver | null): void {
  driver = d;
}
