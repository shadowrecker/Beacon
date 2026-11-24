"use client";

import { formatDistanceToNow } from "date-fns";
import { Mail, RotateCw, X } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { toast } from "@/components/ui/toast";
import { ROLE_LABELS, type Role } from "./use-active-org";

/** Pending invitations of an org (members:manage). */
export function PendingInvites({ orgId, callerRole }: { orgId: string; callerRole: Role }) {
  const utils = trpc.useUtils();
  const invites = trpc.organization.listInvites.useInfiniteQuery(
    { orgId, limit: 25 },
    { getNextPageParam: (last) => last.nextCursor ?? undefined }
  );
  const revoke = trpc.organization.revokeInvite.useMutation();
  const resend = trpc.organization.resendInvite.useMutation();
  const items = invites.data?.pages.flatMap((p) => p.items) ?? [];

  const refresh = () => Promise.all([utils.organization.listInvites.invalidate({ orgId }), utils.organization.get.invalidate({ orgId })]);

  if (invites.isLoading) return <LoadingState rows={2} label="Loading invitations" />;
  if (invites.isError) return <ErrorState message={invites.error.message} onRetry={() => void invites.refetch()} />;
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No pending invitations.</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border">
        {items.map((i) => {
          const manageable = i.role !== "OWNER" || callerRole === "OWNER";
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Mail className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.email}</p>
                <p className="text-xs text-muted-foreground">
                  Invited by {i.invitedBy} {formatDistanceToNow(new Date(i.createdAt), { addSuffix: true })} ·{" "}
                  {i.expired ? "expired" : `expires ${formatDistanceToNow(new Date(i.expiresAt), { addSuffix: true })}`}
                </p>
              </div>
              <Badge variant="outline">{ROLE_LABELS[i.role]}</Badge>
              {i.expired && <Badge variant="destructive">Expired</Badge>}
              {manageable && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={resend.isPending}
                    onClick={() =>
                      void resend
                        .mutateAsync({ orgId, inviteId: i.id })
                        .then(async () => {
                          toast.success(`Sent a new invitation link to ${i.email}`);
                          await refresh();
                        })
                        .catch(() => undefined)
                    }
                  >
                    <RotateCw className="mr-1 h-4 w-4" aria-hidden />
                    Resend
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Revoke invitation for ${i.email}`}
                    disabled={revoke.isPending}
                    onClick={() =>
                      void revoke
                        .mutateAsync({ orgId, inviteId: i.id })
                        .then(async () => {
                          toast.success(`Revoked the invitation for ${i.email}`);
                          await refresh();
                        })
                        .catch(() => undefined)
                    }
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {invites.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void invites.fetchNextPage()} disabled={invites.isFetchingNextPage}>
            {invites.isFetchingNextPage ? "Loading…" : "Show more invitations"}
          </Button>
        </div>
      )}
    </div>
  );
}
