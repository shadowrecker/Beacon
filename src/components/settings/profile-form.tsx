"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";

type Me = RouterOutputs["user"]["me"];

export function ProfileForm({ me }: { me: Me }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(me.name ?? "");
  const update = trpc.user.update.useMutation();
  useEffect(() => setName(me.name ?? ""), [me.name]);
  const trimmed = name.trim();
  const unchanged = trimmed === (me.name ?? "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || unchanged) return;
    try {
      await update.mutateAsync({ name: trimmed });
    } catch {
      return; // surfaced by the global error toast
    }
    toast.success("Profile updated");
    await utils.user.me.invalidate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Profile</CardTitle>
        <CardDescription>How you appear to your teammates in comments, mentions and activity.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="profile-name">Display name</Label>
              <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input id="profile-email" value={me.email ?? ""} readOnly disabled aria-describedby="profile-email-hint" />
              <p id="profile-email-hint" className="text-xs text-muted-foreground">
                Change your email under Account &amp; security below.
              </p>
            </div>
          </div>
          <Button type="submit" disabled={update.isPending || !trimmed || unchanged}>
            {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Save profile
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
