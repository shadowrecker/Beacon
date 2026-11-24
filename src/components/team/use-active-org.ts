"use client";

/**
 * The active organization as the rest of the UI sees it: the stored selection
 * when it's still one of the user's orgs, otherwise the personal workspace.
 * Mirrors the org switcher's resolution so every page agrees.
 */
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { setActiveOrgId, useActiveOrgId } from "@/lib/active-org";

export function useActiveOrg() {
  const storedId = useActiveOrgId();
  const queryClient = useQueryClient();
  const orgs = trpc.organization.listMine.useQuery();
  const list = orgs.data ?? [];
  const active = list.find((o) => o.id === storedId) ?? list.find((o) => o.isPersonal) ?? list[0] ?? null;

  /** Make `orgId` active and refetch everything (all data is org-scoped). */
  const switchTo = useCallback(
    async (orgId: string | null) => {
      setActiveOrgId(orgId);
      await queryClient.resetQueries();
    },
    [queryClient]
  );

  return { orgs, list, active, switchTo };
}

export const ROLE_LABELS = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
} as const;

export const ROLE_DESCRIPTIONS = {
  OWNER: "Full control, including managing owners and deleting the organization",
  ADMIN: "Manage members, integrations, API keys and all projects",
  MEMBER: "Create and edit projects, run analyses and comment",
  VIEWER: "Read-only access to projects",
} as const;

export const ROLE_WITH_ARTICLE = {
  OWNER: "an owner",
  ADMIN: "an admin",
  MEMBER: "a member",
  VIEWER: "a viewer",
} as const;

export type Role = keyof typeof ROLE_LABELS;

/** Roles the caller may assign (only owners can grant the owner role). */
export function assignableRoles(callerRole: Role): Role[] {
  return callerRole === "OWNER" ? ["OWNER", "ADMIN", "MEMBER", "VIEWER"] : ["ADMIN", "MEMBER", "VIEWER"];
}
