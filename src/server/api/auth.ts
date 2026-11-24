/**
 * API keys for the public REST API.
 *
 * - Keys are `bk_live_` + 32 random bytes (base64url). They carry 256 bits of
 *   entropy, so a fast SHA-256 hash is sufficient; only the hash is stored, in a
 *   unique column, and lookups are a single indexed equality (no per-request
 *   bcrypt, no prefix scans).
 * - `prefix` (the first 12 characters) is stored for display only.
 * - Validation rejects revoked and expired keys and keys whose creator is no
 *   longer a joined member of the key's org (keys are also revoked when a member
 *   is removed; this check closes the window in between).
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { getMembership } from "../auth/access";
import { API_SCOPES, MAX_RATE_LIMIT, type ApiScope } from "./scopes";

export const API_KEY_PREFIX = "bk_live_";
const KEY_PATTERN = /^bk_live_[A-Za-z0-9_-]{43}$/;
export const DISPLAY_PREFIX_LENGTH = 12;

export { API_SCOPES, SCOPE_DESCRIPTIONS, MAX_RATE_LIMIT, DEFAULT_RATE_LIMIT, type ApiScope } from "./scopes";

export const scopesSchema = z
  .array(z.enum(API_SCOPES))
  .min(1, "Choose at least one scope")
  .max(API_SCOPES.length)
  .transform((s) => [...new Set(s)]);

export function generateApiKey(): { key: string; keyHash: string; prefix: string } {
  const key = `${API_KEY_PREFIX}${randomToken(32)}`;
  return { key, keyHash: hashApiKey(key), prefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

export interface ApiKeyPrincipal {
  id: string;
  orgId: string;
  scopes: ApiScope[];
  rateLimit: number;
  createdBy: string;
}

export type ApiKeyValidation =
  | { valid: true; key: ApiKeyPrincipal }
  | { valid: false; reason: "missing" | "malformed" | "unknown" | "revoked" | "expired" | "creator_removed" };

/** Extract the key from `Authorization: Bearer <key>` (or `x-api-key`). */
export function extractApiKey(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    return m ? m[1] : null;
  }
  return headers.get("x-api-key")?.trim() || null;
}

const LAST_USED_THROTTLE_MS = 60_000;

export async function validateApiKey(raw: string | null): Promise<ApiKeyValidation> {
  if (!raw) return { valid: false, reason: "missing" };
  if (!KEY_PATTERN.test(raw)) return { valid: false, reason: "malformed" };
  const row = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(raw) },
    select: { id: true, orgId: true, scopes: true, rateLimit: true, createdBy: true, revokedAt: true, expiresAt: true, lastUsedAt: true },
  });
  if (!row) return { valid: false, reason: "unknown" };
  if (row.revokedAt) return { valid: false, reason: "revoked" };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return { valid: false, reason: "expired" };
  const membership = await getMembership(prisma, row.createdBy, row.orgId);
  if (!membership) return { valid: false, reason: "creator_removed" };

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  const allowed = new Set<string>(API_SCOPES);
  return {
    valid: true,
    key: {
      id: row.id,
      orgId: row.orgId,
      scopes: row.scopes.filter((s): s is ApiScope => allowed.has(s)),
      rateLimit: Math.max(1, Math.min(row.rateLimit, MAX_RATE_LIMIT)),
      createdBy: row.createdBy,
    },
  };
}

export function hasScope(key: ApiKeyPrincipal, scope: ApiScope): boolean {
  return key.scopes.includes(scope);
}
