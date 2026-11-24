import type { Metadata } from "next";
import Link from "next/link";
import { Zap } from "lucide-react";

export const metadata: Metadata = { title: "Get started" };

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-4">
          <Link href="/projects" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600">
              <Zap className="h-5 w-5 text-white" aria-hidden />
            </span>
            <span className="text-lg font-bold">Beacon</span>
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-3xl px-4 py-10">
        {children}
      </main>
    </div>
  );
}
