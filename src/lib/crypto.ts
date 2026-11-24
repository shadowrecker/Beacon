/**
 * Cryptographic helpers.
 *
 * Secrets at rest (integration credentials, webhook signing secrets) use AES-256-GCM
 * envelopes with a key version prefix, so keys can be rotated: new writes use
 * CREDENTIALS_KEY_VERSION, and any version still present in
 * CREDENTIALS_ENCRYPTION_KEYS can be decrypted.
 *
 * Envelope format: "v<version>.<iv b64url>.<tag b64url>.<ciphertext b64url>"
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

const ALGO = "aes-256-gcm";

function loadKeys(): { current: number; keys: Map<number, Buffer> } {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEYS;
  const current = Number(process.env.CREDENTIALS_KEY_VERSION ?? "1");
  const keys = new Map<number, Buffer>();
  if (raw) {
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(raw) as Record<string, string>;
    } catch {
      throw new Error("CREDENTIALS_ENCRYPTION_KEYS must be a JSON object of version -> base64 key");
    }
    for (const [version, b64] of Object.entries(parsed)) {
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) {
        throw new Error(`Encryption key version ${version} must decode to 32 bytes`);
      }
      keys.set(Number(version), key);
    }
  } else if (process.env.NODE_ENV !== "production") {
    // Deterministic development key so local data survives restarts. Never used in
    // production: assertServerEnv() requires CREDENTIALS_ENCRYPTION_KEYS there.
    keys.set(current, createHash("sha256").update("beacon-dev-only-key").digest());
  }
  if (!keys.has(current)) {
    throw new Error(`No encryption key configured for CREDENTIALS_KEY_VERSION=${current}`);
  }
  return { current, keys };
}

export function encryptString(plaintext: string): { envelope: string; keyVersion: number } {
  const { current, keys } = loadKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keys.get(current)!, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = [
    `v${current}`,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
  return { envelope, keyVersion: current };
}

export function decryptString(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || !parts[0].startsWith("v")) {
    throw new Error("Malformed encrypted envelope");
  }
  const version = Number(parts[0].slice(1));
  const { keys } = loadKeys();
  const key = keys.get(version);
  if (!key) throw new Error(`No decryption key for version ${version}`);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptJson(value: unknown): { envelope: string; keyVersion: number } {
  return encryptString(JSON.stringify(value));
}

export function decryptJson<T = unknown>(envelope: string): T {
  return JSON.parse(decryptString(envelope)) as T;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return nodeTimingSafeEqual(ab, bb);
}
