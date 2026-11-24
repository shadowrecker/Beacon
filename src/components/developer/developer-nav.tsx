"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/developer", label: "Overview" },
  { href: "/developer/keys", label: "API keys" },
  { href: "/developer/webhooks", label: "Webhooks" },
  { href: "/developer/docs", label: "API reference" },
] as const;

export function DeveloperNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Developer" className="border-b dark:border-gray-800">
      <ul className="-mb-px flex flex-wrap gap-4">
        {ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-block border-b-2 px-1 pb-2 text-sm font-medium",
                  active ? "border-gray-900 text-gray-900 dark:border-gray-100 dark:text-gray-100" : "border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400"
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
