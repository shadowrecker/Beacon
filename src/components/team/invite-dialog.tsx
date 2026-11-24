"use client";

import { useState, type FormEvent } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { assignableRoles, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "./use-active-org";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteDialog({ orgId, callerRole }: { orgId: string; callerRole: Role }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const invite = trpc.organization.invite.useMutation({ meta: { silent: true } });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const address = email.trim();
    if (!EMAIL_RE.test(address)) {
      setError("Enter a valid email address.");
      return;
    }
    try {
      const res = await invite.mutateAsync({ orgId, email: address, role });
      toast.success(`Invitation sent to ${res.email}`);
      setEmail("");
      setRole("MEMBER");
      setOpen(false);
      await Promise.all([utils.organization.listInvites.invalidate({ orgId }), utils.organization.get.invalidate({ orgId })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the invitation.");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="mr-2 h-4 w-4" aria-hidden />
          Invite people
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>Invite someone</DialogTitle>
            <DialogDescription>
              We&apos;ll email them a link that&apos;s valid for 7 days. They join once they accept with that email address.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={254}
              placeholder="name@company.com"
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? "invite-error" : undefined}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="invite-role" aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignableRoles(callerRole).map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
          </div>
          {error && (
            <p id="invite-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
