"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot,
  Code2,
  FolderOpen,
  Lightbulb,
  Mic,
  Network,
  Plug,
  Presentation,
  Settings,
  Store,
  Swords,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const NAV_ITEMS = [
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/knowledge", label: "Knowledge graph", icon: Network },
  { href: "/voice", label: "Voice insights", icon: Mic },
  { href: "/presentations", label: "Presentations", icon: Presentation },
  { href: "/competitive", label: "Competitive", icon: Swords },
  { href: "/coach", label: "Coach", icon: Lightbulb },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/marketplace", label: "Marketplace", icon: Store },
  { href: "/team", label: "Team", icon: Users },
  { href: "/developer", label: "Developer", icon: Code2 },
  { href: "/settings/ai", label: "AI settings", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

interface SidebarProps {
  projects: Array<{ id: string; name: string }>;
  onNavigate?: () => void;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/settings") return pathname === "/settings";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({ projects, onNavigate }: SidebarProps) {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Main" className="flex h-full flex-col">
      <div className="border-b px-5 py-5">
        <Link href="/projects" className="flex items-center gap-2" onClick={onNavigate}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
            <Zap className="h-5 w-5 text-white" aria-hidden />
          </span>
          <span className="text-lg font-bold">Beacon</span>
        </Link>
      </div>

      <ul className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}

        {projects.length > 0 && (
          <li className="pt-6">
            <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent projects</p>
            <ul className="space-y-1">
              {projects.slice(0, 6).map((p) => {
                const href = `/projects/${p.id}`;
                const active = pathname.startsWith(href);
                return (
                  <li key={p.id}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "block truncate rounded-md px-3 py-1.5 text-sm",
                        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      {p.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        )}
      </ul>
    </nav>
  );
}
