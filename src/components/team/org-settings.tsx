"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Crown, Loader2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ConfirmDialog } from "./confirm-dialog";
import { useActiveOrg } from "./use-active-org";

type Org = RouterOutputs["organization"]["get"];

function RenameOrg({ org }: { org: Org }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(org.name);
  const update = trpc.organization.update.useMutation();
  useEffect(() => setName(org.name), [org.name]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === org.name) return;
    try {
      await update.mutateAsync({ orgId: org.id, name: trimmed });
    } catch {
      return; // surfaced by the global error toast
    }
    toast.success("Organization renamed");
    await Promise.all([utils.organization.get.invalidate({ orgId: org.id }), utils.organization.listMine.invalidate()]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Name</CardTitle>
        <CardDescription>Shown to members and in invitation emails.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="org-rename">Organization name</Label>
            <Input id="org-rename" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!org.permissions.manage} />
          </div>
          {org.permissions.manage && (
            <Button type="submit" disabled={update.isPending || !name.trim() || name.trim() === org.name}>
              {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Save
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function TransferOwnership({ org }: { org: Org }) {
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [memberId, setMemberId] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = trpc.organization.listMembers.useQuery({ orgId: org.id, query: query.trim() || undefined, limit: 50 });
  const transfer = trpc.organization.transferOwnership.useMutation({ meta: { silent: true } });
  const candidates = (members.data?.items ?? []).filter((m) => !m.isSelf);
  const selected = candidates.find((m) => m.memberId === memberId);

  const confirm = async () => {
    setError(null);
    try {
      await transfer.mutateAsync({ orgId: org.id, memberId });
      setConfirmOpen(false);
      setMemberId("");
      toast.success(`${selected?.name ?? "They"} now owns ${org.name}`);
      await Promise.all([
        utils.organization.get.invalidate({ orgId: org.id }),
        utils.organization.listMembers.invalidate({ orgId: org.id }),
        utils.organization.listMine.invalidate(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not transfer ownership.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Transfer ownership</CardTitle>
        <CardDescription>Make another member an owner. You&apos;ll become an admin.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="transfer-search">Find a member</Label>
            <Input id="transfer-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or email" maxLength={100} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="transfer-member">New owner</Label>
            <Select value={memberId} onValueChange={setMemberId} disabled={candidates.length === 0}>
              <SelectTrigger id="transfer-member" aria-label="New owner">
                <SelectValue placeholder={members.isLoading ? "Loading…" : candidates.length ? "Choose a member" : "No other members"} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((m) => (
                  <SelectItem key={m.memberId} value={m.memberId}>
                    {m.name}
                    {m.email ? ` (${m.email})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button variant="outline" disabled={!selected} onClick={() => setConfirmOpen(true)}>
          <Crown className="mr-2 h-4 w-4" aria-hidden />
          Transfer ownership
        </Button>
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(o) => {
            setConfirmOpen(o);
            if (!o) setError(null);
          }}
          title={`Make ${selected?.name ?? "this member"} the owner?`}
          description={<p>They&apos;ll get full control of {org.name}. Your role will change to admin.</p>}
          confirmLabel="Transfer ownership"
          pending={transfer.isPending}
          error={error}
          onConfirm={confirm}
        />
      </CardContent>
    </Card>
  );
}

function DangerZone({ org }: { org: Org }) {
  const router = useRouter();
  const { switchTo } = useActiveOrg();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leave = trpc.organization.removeMember.useMutation({ meta: { silent: true } });
  const remove = trpc.organization.delete.useMutation({ meta: { silent: true } });

  const doLeave = async () => {
    if (!org.memberId) return;
    setError(null);
    try {
      await leave.mutateAsync({ orgId: org.id, memberId: org.memberId });
      setLeaveOpen(false);
      toast.success(`You left ${org.name}`);
      await switchTo(null);
      router.push("/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not leave the organization.");
    }
  };

  const doDelete = async (typed: string) => {
    setError(null);
    try {
      const res = await remove.mutateAsync({ orgId: org.id, confirmName: typed });
      setDeleteOpen(false);
      toast.success(`Deleted ${org.name} and ${res.deletedProjects} ${res.deletedProjects === 1 ? "project" : "projects"}`);
      await switchTo(null);
      router.push("/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the organization.");
    }
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
        <CardDescription>These actions can&apos;t be undone.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Leave organization</p>
            <p className="text-sm text-muted-foreground">
              {org.role === "OWNER" ? "Make someone else an owner first if you're the only one." : "You'll lose access to its projects."}
            </p>
          </div>
          <Button variant="outline" onClick={() => setLeaveOpen(true)} disabled={!org.memberId}>
            Leave
          </Button>
        </div>
        {org.permissions.manageOwners && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Delete organization</p>
              <p className="text-sm text-muted-foreground">
                Permanently deletes its {org.counts.projects} {org.counts.projects === 1 ? "project" : "projects"}, documents, analyses and files.
              </p>
            </div>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              Delete organization
            </Button>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={(o) => {
          setLeaveOpen(o);
          if (!o) setError(null);
        }}
        title={`Leave ${org.name}?`}
        description={<p>You&apos;ll lose access to its projects until someone invites you again.</p>}
        confirmLabel="Leave organization"
        destructive
        pending={leave.isPending}
        error={error}
        onConfirm={doLeave}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          setDeleteOpen(o);
          if (!o) setError(null);
        }}
        title={`Delete ${org.name}?`}
        description={
          <>
            <p>This permanently deletes the organization, all of its projects and every uploaded file. Members lose access immediately.</p>
            <p>API keys, webhooks and integrations of this organization stop working.</p>
          </>
        }
        confirmText={org.name}
        confirmLabel="Delete organization"
        destructive
        pending={remove.isPending}
        error={error}
        onConfirm={doDelete}
      />
    </Card>
  );
}

export function OrgSettings({ org }: { org: Org }) {
  if (org.isPersonal) {
    return (
      <div className="space-y-6">
        <RenameOrg org={org} />
        <p className="text-sm text-muted-foreground">
          This is your personal workspace. It&apos;s deleted together with your account from Settings.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <RenameOrg org={org} />
      {org.permissions.manageOwners && <TransferOwnership org={org} />}
      <DangerZone org={org} />
    </div>
  );
}
