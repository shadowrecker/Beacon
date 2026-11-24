"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, Plus } from "lucide-react";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import { setActiveOrgId, useActiveOrgId } from "@/lib/active-org";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

/**
 * Switch the active organization. Every query is refetched after a switch
 * because all data is org-scoped.
 */
export function OrgSwitcher() {
  const activeOrgId = useActiveOrgId();
  const queryClient = useQueryClient();
  const { data: orgs } = trpc.organization.listMine.useQuery();

  const active = orgs?.find((o) => o.id === activeOrgId) ?? orgs?.find((o) => o.isPersonal) ?? orgs?.[0];

  // Drop a stale selection (e.g. removed from that org).
  useEffect(() => {
    if (orgs && activeOrgId && !orgs.some((o) => o.id === activeOrgId)) setActiveOrgId(null);
  }, [orgs, activeOrgId]);

  const select = async (orgId: string) => {
    setActiveOrgId(orgId);
    await queryClient.resetQueries();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-w-[16rem] justify-between gap-2" aria-label="Switch organization">
          <Building2 className="h-4 w-4 flex-shrink-0" aria-hidden />
          <span className="truncate">{active?.name ?? "Workspace"}</span>
          <ChevronsUpDown className="h-4 w-4 flex-shrink-0 opacity-50" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {orgs?.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => void select(o.id)} className="justify-between">
            <span className="truncate">{o.name}</span>
            {o.id === active?.id && <Check className="h-4 w-4" aria-label="Active" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/team?create=1" className="gap-2">
            <Plus className="h-4 w-4" aria-hidden /> New organization
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
