"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/collaboration/notification-bell";
import { CoachBell } from "@/components/coach/coach-bell";
import { OrgSwitcher } from "./org-switcher";
import { ThemeToggle } from "./theme-toggle";

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const pathname = usePathname() ?? "";
  const projectId = pathname.match(/^\/projects\/([a-z0-9]+)/i)?.[1] ?? null;

  return (
    <header className="sticky top-0 z-40 border-b bg-background">
      <div className="flex h-16 items-center gap-3 px-4 md:px-6">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenMenu} aria-label="Open navigation">
          <Menu className="h-5 w-5" aria-hidden />
        </Button>
        <OrgSwitcher />
        <div className="ml-auto flex items-center gap-2">
          {projectId && <CoachBell projectId={projectId} />}
          <NotificationBell />
          <ThemeToggle />
          <UserButton />
        </div>
      </div>
    </header>
  );
}
