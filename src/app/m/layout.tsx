"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, ListMusic, Mic, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/m", label: "Home", icon: Home },
  { href: "/m/record", label: "Record", icon: Mic },
  { href: "/m/recordings", label: "Recordings", icon: ListMusic },
  { href: "/m/quick", label: "Capture", icon: PenLine },
] as const;

/** Mobile shell: compact header, content, and a bottom tab bar (safe-area aware). */
export default function MobileLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/m";
  const active = (href: string) => (href === "/m" ? pathname === "/m" : pathname === href || pathname.startsWith(`${href}/`));
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <Link href="/m" className="text-lg font-bold">
            Beacon
          </Link>
          <Link href="/projects" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Open full app
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-2xl flex-1 px-4 pb-28 pt-4">
        {children}
      </main>
      <nav aria-label="Mobile" className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <ul className="mx-auto grid max-w-2xl grid-cols-4">
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = active(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn("flex flex-col items-center gap-1 py-2 text-xs", isActive ? "text-primary" : "text-muted-foreground")}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
