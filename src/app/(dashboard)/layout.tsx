"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc/client";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { data } = trpc.project.list.useQuery({ limit: 6 });
  const projects = (data?.items ?? []).map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="flex h-screen bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="hidden w-64 flex-shrink-0 border-r md:block">
        <Sidebar projects={projects} />
      </aside>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 border-r bg-background shadow-xl">
            <div className="absolute right-2 top-3">
              <Button variant="ghost" size="icon" onClick={() => setMenuOpen(false)} aria-label="Close navigation">
                <X className="h-5 w-5" aria-hidden />
              </Button>
            </div>
            <Sidebar projects={projects} onNavigate={() => setMenuOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar onOpenMenu={() => setMenuOpen(true)} />
        <main id="main" className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 py-8 md:px-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
