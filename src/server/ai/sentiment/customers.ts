/**
 * Customer / account identity for feedback items.
 *
 * Preferred source is document metadata written by uploads and integrations
 * (customer, account, company, organization, plus *Id variants and a segment
 * or plan). When metadata has no identity, the account named in the text by
 * the classifier is used, keyed by its normalized name.
 */

export interface CustomerIdentity {
  /** Stable key: the source system's ID when known, otherwise `name:<normalized name>`. */
  customerId: string;
  customerName: string;
  segment: string | null;
  source: "metadata" | "text";
}

const NAME_KEYS = ["customerName", "customer", "accountName", "account", "companyName", "company", "organizationName", "organization", "org"];
const ID_KEYS = ["customerId", "accountId", "companyId", "organizationId", "orgId"];
const SEGMENT_KEYS = ["customerSegment", "segment", "plan", "tier"];

function str(v: unknown, max = 120): string | null {
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ").trim();
    return s ? s.slice(0, max) : null;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

export function normalizeCustomerName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[,.]|\b(inc|llc|ltd|gmbh|corp|corporation|co)\b\.?/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Identity from document metadata (null if none present). */
export function identityFromMetadata(metadata: unknown): CustomerIdentity | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  const rawName = pick(m, NAME_KEYS);
  let name: string | null = null;
  let id: string | null = str(pick(m, ID_KEYS), 100);
  if (rawName && typeof rawName === "object" && !Array.isArray(rawName)) {
    const o = rawName as Record<string, unknown>;
    name = str(o.name ?? o.displayName ?? o.title);
    id ??= str(o.id ?? o.externalId, 100);
  } else {
    name = str(rawName);
  }
  const segment = segmentFromMetadata(m);
  if (!name && !id) return null;
  const displayName = name ?? `Account ${id}`;
  const key = id ? `id:${id}` : `name:${normalizeCustomerName(displayName)}`;
  if (key === "name:") return null;
  return { customerId: key, customerName: displayName, segment, source: "metadata" };
}

export function segmentFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const v = pick(metadata as Record<string, unknown>, SEGMENT_KEYS);
  const s = str(v, 60);
  return s ? s.toLowerCase() : null;
}

/** Identity from an account name the classifier found in the text. */
export function identityFromText(name: string | null | undefined, segment: string | null): CustomerIdentity | null {
  const display = str(name);
  if (!display) return null;
  const norm = normalizeCustomerName(display);
  if (norm.length < 2) return null;
  return { customerId: `name:${norm}`, customerName: display, segment, source: "text" };
}
