"use client";

import { trpc } from "@/lib/trpc";
import { useActiveOrgId } from "@/lib/active-org";

export type OrgRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

/**
 * The caller's role in the active workspace (the personal workspace when none
 * is selected). Used only to decide which actions to show; the server enforces
 * every permission itself.
 */
export function useActiveRole(): { role: OrgRole | null; isLoading: boolean } {
  const activeOrgId = useActiveOrgId();
  const orgs = trpc.organization.listMine.useQuery();
  const list = orgs.data ?? [];
  const org = (activeOrgId ? list.find((o) => o.id === activeOrgId) : undefined) ?? list.find((o) => o.isPersonal) ?? list[0];
  return { role: (org?.role as OrgRole | undefined) ?? null, isLoading: orgs.isLoading };
}

export function canManageIntegrations(role: OrgRole | null): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function canWrite(role: OrgRole | null): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "MEMBER";
}
