"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignOutButton, useAuth } from "@clerk/nextjs";
import { format } from "date-fns";
import { AlertTriangle, Building2, CheckCircle2, Loader2, MailX } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/states";
import { ROLE_DESCRIPTIONS, ROLE_WITH_ARTICLE, useActiveOrg } from "./use-active-org";

function Shell({
  icon,
  title,
  description,
  children,
  footer,
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-3 text-center">
        <div className="mx-auto" aria-hidden>
          {icon}
        </div>
        <CardTitle className="text-xl">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {children && <CardContent className="space-y-3 text-sm">{children}</CardContent>}
      {footer && <CardFooter className="flex flex-col gap-2 sm:flex-row sm:justify-center">{footer}</CardFooter>}
    </Card>
  );
}

function SignedOutInvite({ token }: { token: string }) {
  const back = encodeURIComponent(`/invite/${token}`);
  return (
    <Shell
      icon={<Building2 className="h-10 w-10 text-primary" />}
      title="You've been invited to Beacon"
      description="Sign in, or create an account, with the email address this invitation was sent to. You'll see who invited you and can accept on the next screen."
      footer={
        <>
          <Button asChild>
            <Link href={`/sign-in?redirect_url=${back}`}>Sign in</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href={`/sign-up?redirect_url=${back}`}>Create an account</Link>
          </Button>
        </>
      }
    />
  );
}

function SignedInInvite({ token }: { token: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { switchTo } = useActiveOrg();
  const invite = trpc.organization.getInvite.useQuery({ token }, { retry: false });
  const accept = trpc.organization.acceptInvite.useMutation({ meta: { silent: true } });
  const decline = trpc.organization.declineInvite.useMutation({ meta: { silent: true } });
  const [declined, setDeclined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = encodeURIComponent(`/invite/${token}`);

  if (invite.isLoading) return <LoadingState rows={2} label="Loading invitation" />;
  if (invite.isError || !invite.data || !invite.data.found) {
    return (
      <Shell
        icon={<MailX className="h-10 w-10 text-muted-foreground" />}
        title="This invitation link isn't valid"
        description="It may have been mistyped, or a newer invitation replaced it. Ask the person who invited you to send it again."
        footer={
          <Button variant="outline" asChild>
            <Link href="/projects">Go to Beacon</Link>
          </Button>
        }
      />
    );
  }

  const inv = invite.data;
  const goToOrg = async () => {
    await switchTo(inv.orgId);
    router.push("/projects");
  };

  if (declined) {
    return (
      <Shell
        icon={<CheckCircle2 className="h-10 w-10 text-muted-foreground" />}
        title="Invitation declined"
        description={`You won't join ${inv.orgName}. ${inv.inviterName} can invite you again later.`}
        footer={
          <Button variant="outline" asChild>
            <Link href="/projects">Go to Beacon</Link>
          </Button>
        }
      />
    );
  }

  if (inv.status === "accepted" || inv.alreadyMember) {
    return (
      <Shell
        icon={<CheckCircle2 className="h-10 w-10 text-green-600" />}
        title={inv.alreadyMember ? `You're a member of ${inv.orgName}` : "This invitation was already used"}
        description={inv.alreadyMember ? undefined : "If that wasn't you, ask for a new invitation."}
        footer={
          inv.alreadyMember ? (
            <Button onClick={() => void goToOrg()}>Open {inv.orgName}</Button>
          ) : (
            <Button variant="outline" asChild>
              <Link href="/projects">Go to Beacon</Link>
            </Button>
          )
        }
      />
    );
  }

  if (inv.status === "revoked" || inv.status === "expired") {
    return (
      <Shell
        icon={<AlertTriangle className="h-10 w-10 text-amber-500" />}
        title={inv.status === "expired" ? "This invitation has expired" : "This invitation is no longer active"}
        description={
          inv.status === "expired"
            ? `It expired on ${format(new Date(inv.expiresAt), "PPP")}. Ask ${inv.inviterName} to send a new invitation to ${inv.orgName}.`
            : `${inv.inviterName} revoked it, or it was declined. Ask for a new invitation to ${inv.orgName} if you still need access.`
        }
        footer={
          <Button variant="outline" asChild>
            <Link href="/projects">Go to Beacon</Link>
          </Button>
        }
      />
    );
  }

  if (!inv.emailMatches) {
    return (
      <Shell
        icon={<AlertTriangle className="h-10 w-10 text-amber-500" />}
        title="This invitation is for a different email"
        description={
          <>
            {inv.inviterName} invited <span className="font-medium text-foreground">{inv.invitedEmail}</span> to join {inv.orgName}
            {inv.signedInEmail ? (
              <>
                , but you&apos;re signed in as <span className="font-medium text-foreground">{inv.signedInEmail}</span>
              </>
            ) : null}
            . Sign in with the invited address to accept. If it belongs to you, you can also add and verify it under Settings → Account &amp;
            security.
          </>
        }
        footer={
          <>
            <SignOutButton redirectUrl={`/sign-in?redirect_url=${back}`}>
              <Button>Sign in with another account</Button>
            </SignOutButton>
            <Button variant="outline" asChild>
              <Link href="/settings">Open settings</Link>
            </Button>
          </>
        }
      />
    );
  }

  const run = async (action: "accept" | "decline") => {
    setError(null);
    try {
      if (action === "accept") {
        await accept.mutateAsync({ token });
        await utils.organization.listMine.invalidate();
        await goToOrg();
      } else {
        await decline.mutateAsync({ token });
        setDeclined(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  };
  const pending = accept.isPending || decline.isPending;

  return (
    <Shell
      icon={<Building2 className="h-10 w-10 text-primary" />}
      title={`Join ${inv.orgName}`}
      description={`${inv.inviterName} invited you to join as ${ROLE_WITH_ARTICLE[inv.role]}.`}
      footer={
        <>
          <Button onClick={() => void run("accept")} disabled={pending}>
            {accept.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Accept invitation
          </Button>
          <Button variant="outline" onClick={() => void run("decline")} disabled={pending}>
            {decline.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            Decline
          </Button>
        </>
      }
    >
      <p className="text-center text-muted-foreground">{ROLE_DESCRIPTIONS[inv.role]}.</p>
      <p className="text-center text-xs text-muted-foreground">Expires {format(new Date(inv.expiresAt), "PPP")}</p>
      {error && (
        <p role="alert" className="text-center text-destructive">
          {error}
        </p>
      )}
    </Shell>
  );
}

export function InviteAcceptance({ token }: { token: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingState rows={2} label="Loading" />;
  return isSignedIn ? <SignedInInvite token={token} /> : <SignedOutInvite token={token} />;
}
