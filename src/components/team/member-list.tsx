"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { LogOut, UserMinus } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { ConfirmDialog } from "./confirm-dialog";
import { assignableRoles, ROLE_LABELS, useActiveOrg, type Role } from "./use-active-org";

type Member = RouterOutputs["organization"]["listMembers"]["items"][number];

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

export function MemberAvatar({ name, avatarUrl, size = "h-8 w-8" }: { name: string; avatarUrl: string | null; size?: string }) {
  return (
    <Avatar className={size}>
      {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
      <AvatarFallback className="bg-muted text-xs font-medium">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

interface MemberListProps {
  orgId: string;
  callerRole: Role;
  isPersonal: boolean;
}

export function MemberList({ orgId, callerRole, isPersonal }: MemberListProps) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { switchTo } = useActiveOrg();
  const members = trpc.organization.listMembers.useInfiniteQuery(
    { orgId, limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const updateRole = trpc.organization.updateMemberRole.useMutation();
  const remove = trpc.organization.removeMember.useMutation({ meta: { silent: true } });
  const [pendingRemoval, setPendingRemoval] = useState<Member | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const canManage = callerRole === "OWNER" || callerRole === "ADMIN";
  const items = members.data?.pages.flatMap((p) => p.items) ?? [];

  const changeRole = async (m: Member, role: Role) => {
    await updateRole.mutateAsync({ orgId, memberId: m.memberId, role });
    toast.success(`${m.name}'s role is now ${ROLE_LABELS[role]}`);
    await Promise.all([
      utils.organization.listMembers.invalidate({ orgId }),
      utils.organization.get.invalidate({ orgId }),
      utils.organization.listMine.invalidate(),
    ]);
  };

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    setRemoveError(null);
    try {
      const res = await remove.mutateAsync({ orgId, memberId: pendingRemoval.memberId });
      setPendingRemoval(null);
      if (res.left) {
        toast.success("You left the organization");
        await switchTo(null);
        router.push("/projects");
        return;
      }
      toast.success(
        res.revokedApiKeys > 0
          ? `Removed ${pendingRemoval.name} and revoked ${res.revokedApiKeys} API ${res.revokedApiKeys === 1 ? "key" : "keys"} they created`
          : `Removed ${pendingRemoval.name}`
      );
      await Promise.all([utils.organization.listMembers.invalidate({ orgId }), utils.organization.get.invalidate({ orgId })]);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Could not remove this member.");
    }
  };

  if (members.isLoading) return <LoadingState rows={3} label="Loading members" />;
  if (members.isError) return <ErrorState message={members.error.message} onRetry={() => void members.refetch()} />;
  if (items.length === 0) return <EmptyState title="No members found" />;

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="sr-only">Organization members</caption>
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Member
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Role
              </th>
              <th scope="col" className="hidden px-4 py-3 font-medium md:table-cell">
                Joined
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((m) => {
              const targetIsOwner = m.role === "OWNER";
              const editable = canManage && !isPersonal && (!targetIsOwner || callerRole === "OWNER");
              const removable = !m.isSelf && editable;
              const options = assignableRoles(callerRole);
              return (
                <tr key={m.memberId}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <MemberAvatar name={m.name} avatarUrl={m.avatarUrl} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">
                          {m.name}
                          {m.isSelf && (
                            <Badge variant="secondary" className="ml-2 align-middle">
                              You
                            </Badge>
                          )}
                        </p>
                        {m.email && <p className="truncate text-xs text-muted-foreground">{m.email}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {editable ? (
                      <Select
                        value={m.role}
                        onValueChange={(v) => void changeRole(m, v as Role).catch(() => undefined)}
                        disabled={updateRole.isPending}
                      >
                        <SelectTrigger className="h-9 w-32" aria-label={`Role for ${m.name}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(options.includes(m.role) ? options : [m.role, ...options]).map((r) => (
                            <SelectItem key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant={targetIsOwner ? "default" : "outline"}>{ROLE_LABELS[m.role]}</Badge>
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                    <time dateTime={new Date(m.joinedAt).toISOString()}>{format(new Date(m.joinedAt), "MMM d, yyyy")}</time>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {m.isSelf && !isPersonal ? (
                      <Button variant="ghost" size="sm" onClick={() => setPendingRemoval(m)}>
                        <LogOut className="mr-2 h-4 w-4" aria-hidden />
                        Leave
                      </Button>
                    ) : removable ? (
                      <Button variant="ghost" size="sm" onClick={() => setPendingRemoval(m)} aria-label={`Remove ${m.name}`}>
                        <UserMinus className="h-4 w-4" aria-hidden />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {members.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void members.fetchNextPage()} disabled={members.isFetchingNextPage}>
            {members.isFetchingNextPage ? "Loading…" : "Show more members"}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingRemoval}
        onOpenChange={(open) => {
          if (!open) {
            setPendingRemoval(null);
            setRemoveError(null);
          }
        }}
        title={pendingRemoval?.isSelf ? "Leave this organization?" : `Remove ${pendingRemoval?.name ?? "member"}?`}
        description={
          pendingRemoval?.isSelf ? (
            <p>You&apos;ll lose access to its projects. You can only rejoin if someone invites you again.</p>
          ) : (
            <>
              <p>They&apos;ll lose access to every project in this organization.</p>
              <p>API keys they created here will be revoked. Projects and comments they created stay with the organization.</p>
            </>
          )
        }
        confirmLabel={pendingRemoval?.isSelf ? "Leave organization" : "Remove member"}
        destructive
        pending={remove.isPending}
        error={removeError}
        onConfirm={confirmRemoval}
      />
    </div>
  );
}
