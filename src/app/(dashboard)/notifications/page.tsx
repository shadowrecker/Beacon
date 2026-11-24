import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { NotificationList } from "@/components/collaboration/notification-list";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title="Notifications"
        description="Mentions, replies, finished analyses and updates from your organizations"
        actions={
          <Button variant="outline" asChild>
            <Link href="/settings#notifications">Email preferences</Link>
          </Button>
        }
      />
      <NotificationList />
    </div>
  );
}
