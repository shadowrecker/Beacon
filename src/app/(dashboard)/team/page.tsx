"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Building2, Plus } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivityFeed } from "@/components/team/activity-feed";
import { CreateOrgDialog } from "@/components/team/create-org-dialog";
import { CrossProjectThemes } from "@/components/team/cross-project-themes";
import { InviteDialog } from "@/components/team/invite-dialog";
import { MemberList } from "@/components/team/member-list";
import { MyInvites } from "@/components/team/my-invites";
import { OrgSettings } from "@/components/team/org-settings";
import { PendingInvites } from "@/components/team/pending-invites";
import { TeamDashboard } from "@/components/team/team-dashboard";
import { ROLE_LABELS, useActiveOrg } from "@/components/team/use-active-org";

const TABS = ["overview", "activity", "members", "settings"] as const;
type Tab = (typeof TABS)[number];

function TeamPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { orgs, list, active, switchTo } = useActiveOrg();
  const [createOpen, setCreateOpen] = useState(params.get("create") === "1");
  const requestedTab = params.get("tab");
  const [tab, setTab] = useState<Tab>(TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "overview");

  // Links like /team?org=<id> (from notifications) switch to that org when the user belongs to it.
  const requestedOrg = params.get("org");
  useEffect(() => {
    if (!requestedOrg || !orgs.data) return;
    const target = list.find((o) => o.id === requestedOrg);
    const next = new URLSearchParams(params.toString());
    next.delete("org");
    const query = next.toString();
    void (async () => {
      if (target && target.id !== active?.id) await switchTo(target.id);
      router.replace(query ? `${pathname}?${query}` : pathname);
    })();
  }, [requestedOrg, orgs.data, list, active?.id, switchTo, router, pathname, params]);

  useEffect(() => {
    if (params.get("create") === "1") setCreateOpen(true);
  }, [params]);

  const closeCreate = (open: boolean) => {
    setCreateOpen(open);
    if (!open && params.get("create")) router.replace(pathname);
  };

  const org = trpc.organization.get.useQuery({ orgId: active?.id ?? "" }, { enabled: !!active });

  if (orgs.isLoading || (active && org.isLoading)) return <LoadingState rows={4} label="Loading team" />;
  if (orgs.isError) return <ErrorState message={orgs.error.message} onRetry={() => void orgs.refetch()} />;
  if (!active) return <ErrorState message="No workspace is available for your account." onRetry={() => void orgs.refetch()} />;
  if (org.isError) return <ErrorState message={org.error.message} onRetry={() => void org.refetch()} />;
  const o = org.data;
  if (!o) return <LoadingState rows={4} label="Loading team" />;

  const canInvite = o.permissions.manageMembers && !o.isPersonal;

  return (
    <div className="space-y-8">
      <PageHeader
        title={o.name}
        description={
          o.isPersonal
            ? "Your personal workspace. Projects here are visible only to you."
            : `${o.counts.members} ${o.counts.members === 1 ? "member" : "members"} · ${o.counts.projects} ${o.counts.projects === 1 ? "project" : "projects"}`
        }
        actions={
          <>
            <Badge variant="outline">{o.plan.charAt(0) + o.plan.slice(1).toLowerCase()} plan</Badge>
            <Badge variant="secondary">{ROLE_LABELS[o.role]}</Badge>
            {canInvite && <InviteDialog orgId={o.id} callerRole={o.role} />}
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden />
              New organization
            </Button>
          </>
        }
      />

      <MyInvites onAccepted={(res) => switchTo(res.orgId)} />

      {o.isPersonal && (
        <Card>
          <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Building2 className="mt-0.5 h-5 w-5 text-muted-foreground" aria-hidden />
              <div>
                <p className="font-medium">Working with a team?</p>
                <p className="text-sm text-muted-foreground">
                  Create an organization to share projects, invite colleagues and see activity across everyone&apos;s work.
                </p>
              </div>
            </div>
            <Button onClick={() => setCreateOpen(true)}>Create an organization</Button>
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 pt-4">
          <TeamDashboard orgId={o.id} />
          <CrossProjectThemes orgId={o.id} />
        </TabsContent>

        <TabsContent value="activity" className="pt-4">
          <ActivityFeed orgId={o.id} />
        </TabsContent>

        <TabsContent value="members" className="space-y-8 pt-4">
          <section aria-labelledby="members-heading" className="space-y-3">
            <h2 id="members-heading" className="text-lg font-semibold">
              Members
            </h2>
            <MemberList orgId={o.id} callerRole={o.role} isPersonal={o.isPersonal} />
            {!o.isPersonal && (
              <p className="text-xs text-muted-foreground">
                {o.counts.members + o.counts.pendingInvites} of {o.limits.maxMembers.toLocaleString()} seats used on your plan (including
                pending invitations).
              </p>
            )}
          </section>
          {o.permissions.manageMembers && !o.isPersonal && (
            <section aria-labelledby="invites-heading" className="space-y-3">
              <h2 id="invites-heading" className="text-lg font-semibold">
                Pending invitations
              </h2>
              <PendingInvites orgId={o.id} callerRole={o.role} />
            </section>
          )}
        </TabsContent>

        <TabsContent value="settings" className="pt-4">
          <OrgSettings org={o} />
        </TabsContent>
      </Tabs>

      <CreateOrgDialog
        open={createOpen}
        onOpenChange={closeCreate}
        onCreated={async (created) => {
          closeCreate(false);
          await switchTo(created.id);
          setTab("members");
        }}
      />
    </div>
  );
}

export default function TeamPage() {
  return (
    <Suspense fallback={<LoadingState rows={4} label="Loading team" />}>
      <TeamPageContent />
    </Suspense>
  );
}
