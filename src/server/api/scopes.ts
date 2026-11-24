/**
 * API key scopes and limits. Isomorphic (no server imports) so the developer
 * UI renders exactly the allowlist the server enforces.
 */
export const API_SCOPES = [
  "projects:read",
  "projects:write",
  "documents:read",
  "documents:write",
  "synthesis:read",
  "synthesis:write",
  "recommendations:read",
  "voice:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "projects:read": "List and read projects",
  "projects:write": "Create and rename projects",
  "documents:read": "List and read documents",
  "documents:write": "Add and delete text documents",
  "synthesis:read": "Read syntheses and themes",
  "synthesis:write": "Start syntheses (uses AI credits)",
  "recommendations:read": "List recommendations",
  "voice:read": "Read voice recordings and insights",
};

/** Requests per minute. */
export const MAX_RATE_LIMIT = 1200;
export const DEFAULT_RATE_LIMIT = 600;
export const MAX_KEY_LIFETIME_DAYS = 365;
