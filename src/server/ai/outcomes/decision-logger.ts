/**
 * Decision log validation.
 *
 * Evidence links are rendered as hrefs, so only absolute http(s) URLs without
 * embedded credentials are accepted (`z.string().url()` alone would accept
 * javascript:, data: and other schemes).
 */
import { z } from "zod";

export const MAX_EVIDENCE_LINKS = 20;

export function isSafeHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}

export const evidenceLinkSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(isSafeHttpUrl, { message: "Evidence links must be http:// or https:// URLs" });

export const evidenceLinksSchema = z
  .array(evidenceLinkSchema)
  .max(MAX_EVIDENCE_LINKS, `At most ${MAX_EVIDENCE_LINKS} evidence links`)
  .transform((links) => [...new Set(links)]);
