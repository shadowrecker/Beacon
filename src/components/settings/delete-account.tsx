"use client";

import { useState } from "react";
import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/team/confirm-dialog";

export function DeleteAccount() {
  const { signOut } = useClerk();
  const blockers = trpc.user.deletionBlockers.useQuery();
  const remove = trpc.user.deleteAccount.useMutation({ meta: { silent: true } });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = (blockers.data?.length ?? 0) > 0;

  const confirm = async () => {
    setError(null);
    try {
      await remove.mutateAsync({ confirm: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't delete your account. Please try again.");
      return;
    }
    setOpen(false);
    await signOut({ redirectUrl: "/" });
  };

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-lg text-destructive">Delete account</CardTitle>
        <CardDescription>
          Permanently deletes your account, your personal workspace and its projects, and your comments, questions and notifications.
          Projects you created in shared organizations stay with those organizations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {blocked && (
          <div role="alert" className="rounded-md border border-destructive/30 p-3 text-sm">
            <p className="font-medium">You&apos;re the only owner of:</p>
            <ul className="mt-1 list-inside list-disc">
              {blockers.data?.map((b) => (
                <li key={b.id}>
                  <Link href={`/team?org=${b.id}&tab=settings`} className="underline">
                    {b.name}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-muted-foreground">Make someone else an owner or delete these organizations first.</p>
          </div>
        )}
        {blockers.isError && <p className="text-sm text-destructive">Couldn&apos;t check your organizations. Reload to try again.</p>}
        <Button variant="destructive" onClick={() => setOpen(true)} disabled={blockers.isLoading || blocked || blockers.isError}>
          Delete my account
        </Button>
        <ConfirmDialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setError(null);
          }}
          title="Delete your account?"
          description={
            <>
              <p>This can&apos;t be undone. You&apos;ll be signed out and your data will be erased.</p>
              <p>Consider exporting your data first.</p>
            </>
          }
          confirmText="DELETE"
          confirmLabel="Delete my account"
          destructive
          pending={remove.isPending}
          error={error}
          onConfirm={confirm}
        />
      </CardContent>
    </Card>
  );
}
