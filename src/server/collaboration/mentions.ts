/**
 * @mentions in comments.
 *
 * The mention picker inserts tokens of the form `@[Display Name](user:<userId>)`.
 * Tokens are authoritative: each ID must be a joined member of the project's
 * organization, otherwise the comment is rejected. A plain `@handle` typed by
 * hand resolves only when exactly one member of the same organization has that
 * email local-part; it never resolves to anyone outside the org.
 */
import type { DbClient } from "@/lib/db";

export const MAX_MENTIONS = 20;

const TOKEN_RE = /@\[([^\]\n]{1,100})\]\(user:([a-z0-9]{10,40})\)/gi;
const HANDLE_RE = /(^|[^\w@\]])@([a-z0-9][a-z0-9._-]{0,63})/gi;

export interface ParsedMentions {
  /** User IDs from picker tokens, in order of first appearance. */
  tokenUserIds: string[];
  /** Lower-cased plain @handles (outside tokens). */
  handles: string[];
}

export function parseMentions(content: string): ParsedMentions {
  const tokenUserIds: string[] = [];
  for (const m of content.matchAll(TOKEN_RE)) {
    if (!tokenUserIds.includes(m[2])) tokenUserIds.push(m[2]);
  }
  const withoutTokens = content.replace(TOKEN_RE, " ");
  const handles: string[] = [];
  for (const m of withoutTokens.matchAll(HANDLE_RE)) {
    const h = m[2].replace(/[._-]+$/, "").toLowerCase();
    if (h && !handles.includes(h)) handles.push(h);
  }
  return { tokenUserIds, handles };
}

export class MentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MentionError";
  }
}

/**
 * Resolve mentions to user IDs of joined members of `orgId`.
 * Throws MentionError when a token names someone outside the org, or when there
 * are too many mentions.
 */
export async function resolveMentions(db: DbClient, orgId: string, content: string): Promise<string[]> {
  const { tokenUserIds, handles } = parseMentions(content);
  if (tokenUserIds.length === 0 && handles.length === 0) return [];
  if (tokenUserIds.length > MAX_MENTIONS) throw new MentionError(`You can mention at most ${MAX_MENTIONS} people in one comment`);

  const resolved = new Set<string>();
  if (tokenUserIds.length > 0) {
    const members = await db.orgMember.findMany({
      where: { orgId, userId: { in: tokenUserIds }, joinedAt: { not: null } },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    if (tokenUserIds.some((id) => !memberIds.has(id))) {
      throw new MentionError("You can only mention members of this organization");
    }
    tokenUserIds.forEach((id) => resolved.add(id));
  }

  if (handles.length > 0) {
    // Bounded: an org's members, matched in memory on the email local-part.
    const members = await db.orgMember.findMany({
      where: { orgId, joinedAt: { not: null }, user: { email: { not: null } } },
      select: { userId: true, user: { select: { email: true } } },
      take: 10_000,
    });
    for (const handle of handles) {
      const matches = members.filter((m) => m.user.email?.split("@")[0]?.toLowerCase() === handle);
      if (matches.length === 1) resolved.add(matches[0].userId);
    }
  }

  const ids = [...resolved];
  if (ids.length > MAX_MENTIONS) throw new MentionError(`You can mention at most ${MAX_MENTIONS} people in one comment`);
  return ids;
}

/** Replace picker tokens with "@Name" (current names when known) for plain-text use. */
export function mentionsToPlainText(content: string, names: Map<string, string> = new Map()): string {
  return content.replace(TOKEN_RE, (_all, label: string, id: string) => `@${names.get(id) ?? label}`);
}

/** User IDs referenced by picker tokens (no validation). */
export function tokenUserIds(content: string): string[] {
  return parseMentions(content).tokenUserIds;
}
