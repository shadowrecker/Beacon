"use client";

import { formatDistanceToNow } from "date-fns";
import { Check, Loader2, X } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { ROLE_LABELS } from "./use-active-org";

interface MyInvitesProps {
  /** Called after an invitation is accepted, with the org that was joined. */
  onAccepted?: (org: { orgId: string; orgName: string }) => void | Promise<void>;
  /** Render nothing (instead of an empty message) when there are no invitations. */
  hideWhenEmpty?: boolean;
}

/** Invitations addressed to the signed-in user, with accept/decline. */
export function MyInvites({ onAccepted, hideWhenEmpty = true }: MyInvitesProps) {
  const utils = trpc.useUtils();
  const invites = trpc.organization.myInvites.useQuery();
  const accept = trpc.organization.acceptInvite.useMutation();
  const decline = trpc.organization.declineInvite.useMutation();

  const refresh = () =>
    Promise.all([
      utils.organization.myInvites.invalidate(),
      utils.organization.listMine.invalidate(),
      utils.collaboration.unreadCount.invalidate(),
      utils.collaboration.getNotifications.invalidate(),
    ]);

  if (invites.isLoading || invites.isError) return null;
  const list = invites.data ?? [];
  if (list.length === 0 && hideWhenEmpty) return null;

  return (
    <Card id="invitations">
      <CardHeader>
        <CardTitle className="text-lg">Invitations for you</CardTitle>
        <CardDescription>Organizations that invited your email address.</CardDescription>
      </CardHeader>
      <CardContent>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no pending invitations.</p>
        ) : (
          <ul className="divide-y">
            {list.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{i.orgName}</p>
                  <p className="text-xs text-muted-foreground">
                    {i.inviterName} invited you {formatDistanceToNow(new Date(i.createdAt), { addSuffix: true })} · expires{" "}
                    {formatDistanceToNow(new Date(i.expiresAt), { addSuffix: true })}
                  </p>
                </div>
                <Badge variant="outline">{ROLE_LABELS[i.role]}</Badge>
                <Button
                  size="sm"
                  disabled={accept.isPending || decline.isPending}
                  onClick={() =>
                    void accept
                      .mutateAsync({ inviteId: i.id })
                      .then(async (res) => {
                        toast.success(`You joined ${res.orgName}`);
                        await refresh();
                        await onAccepted?.(res);
                      })
                      .catch(() => undefined)
                  }
                >
                  {accept.isPending && accept.variables && "inviteId" in accept.variables && accept.variables.inviteId === i.id ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Check className="mr-1 h-4 w-4" aria-hidden />
                  )}
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={accept.isPending || decline.isPending}
                  onClick={() =>
                    void decline
                      .mutateAsync({ inviteId: i.id })
                      .then(async () => {
                        toast.success(`Declined the invitation to ${i.orgName}`);
                        await refresh();
                      })
                      .catch(() => undefined)
                  }
                >
                  <X className="mr-1 h-4 w-4" aria-hidden />
                  Decline
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
