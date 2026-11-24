"use client";

import Link from "next/link";
import { UserProfile } from "@clerk/nextjs";
import { Bot, Code2, ChevronRight } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { ProfileForm } from "@/components/settings/profile-form";
import { NotificationPreferences } from "@/components/settings/notification-preferences";
import { DataExport } from "@/components/settings/data-export";
import { DeleteAccount } from "@/components/settings/delete-account";

const LINKS = [
  { href: "/settings/ai", icon: Bot, label: "AI settings", description: "Customize how Beacon's AI analyzes feedback for your organization" },
  { href: "/developer", icon: Code2, label: "API access", description: "API keys and webhooks for the Beacon REST API" },
] as const;

export default function SettingsPage() {
  const me = trpc.user.me.useQuery();

  return (
    <div className="max-w-4xl space-y-8">
      <PageHeader title="Settings" description="Your profile, notifications, sign-in security and data" />

      {me.isLoading ? (
        <LoadingState rows={3} label="Loading settings" />
      ) : me.isError ? (
        <ErrorState message={me.error.message} onRetry={() => void me.refetch()} />
      ) : me.data ? (
        <>
          <ProfileForm me={me.data} />
          <NotificationPreferences prefs={me.data.notificationPrefs} />
        </>
      ) : null}

      <section aria-labelledby="security-heading" className="space-y-3">
        <div>
          <h2 id="security-heading" className="text-lg font-semibold">
            Account &amp; security
          </h2>
          <p className="text-sm text-muted-foreground">Email addresses, password, two-factor authentication and active sessions.</p>
        </div>
        <UserProfile
          routing="hash"
          appearance={{
            elements: {
              rootBox: "w-full",
              cardBox: "w-full max-w-none shadow-none border rounded-lg",
            },
          }}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">More settings</CardTitle>
          <CardDescription>Organization-level configuration</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="flex items-center gap-3 py-3 hover:text-primary">
                  <l.icon className="h-5 w-5 text-muted-foreground" aria-hidden />
                  <span className="flex-1">
                    <span className="block font-medium">{l.label}</span>
                    <span className="block text-sm text-muted-foreground">{l.description}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <DataExport />
      <DeleteAccount />
    </div>
  );
}
