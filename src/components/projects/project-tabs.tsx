"use client";

/**
 * Project sub-navigation. Tabs are links (each sub-page has its own URL); the
 * current one is marked with aria-current="page".
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const PROJECT_TABS = [
  { segment: "", label: "Overview" },
  { segment: "documents", label: "Documents" },
  { segment: "synthesis", label: "Synthesis" },
  { segment: "recommendations", label: "Recommendations" },
  { segment: "query", label: "Ask" },
  { segment: "roadmap", label: "Roadmap" },
  { segment: "analytics", label: "Analytics" },
  { segment: "outcomes", label: "Outcomes" },
  { segment: "decisions", label: "Decisions" },
  { segment: "sentiment", label: "Sentiment" },
] as const;

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname() ?? "";
  const base = `/projects/${projectId}`;
  return (
    <nav aria-label="Project sections" className="-mx-1 overflow-x-auto border-b border-gray-200 dark:border-gray-800">
      <ul className="flex min-w-max gap-1 px-1">
        {PROJECT_TABS.map((tab) => {
          const href = tab.segment ? `${base}/${tab.segment}` : base;
          const active = tab.segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === base;
          return (
            <li key={tab.label}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                  active
                    ? "border-blue-500 text-blue-600 dark:text-blue-400"
                    : "border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
