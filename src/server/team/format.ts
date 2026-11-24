/** Display helpers shared by team and collaboration features. */

export function displayName(user: { name?: string | null; email?: string | null } | null | undefined): string {
  const name = user?.name?.trim();
  if (name) return name;
  const local = user?.email?.split("@")[0];
  return local || "A former member";
}

/** "jane.doe@example.com" -> "ja•••@example.com" (for showing an invite address to a non-matching account). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "•••";
  const visible = local.slice(0, Math.min(2, Math.max(1, local.length - 1)));
  return `${visible}•••@${domain}`;
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
