"use client";

import { cn } from "@/lib/utils";

export const CATEGORIES = [
  { value: "SUPPORT", label: "Support" },
  { value: "CRM", label: "CRM" },
  { value: "COMMUNICATION", label: "Communication" },
  { value: "PRODUCT", label: "Product" },
  { value: "RESEARCH", label: "Research" },
  { value: "ANALYTICS", label: "Analytics" },
  { value: "CUSTOM", label: "Custom" },
] as const;

export type Category = (typeof CATEGORIES)[number]["value"];

export function categoryLabel(value: string): string {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

/** Toggle buttons for one category (or all). */
export function CategoryFilter({ value, onChange }: { value: Category | null; onChange: (c: Category | null) => void }) {
  const options: Array<{ value: Category | null; label: string }> = [{ value: null, label: "All" }, ...CATEGORIES];
  return (
    <div role="group" aria-label="Filter by category" className="flex flex-wrap gap-2">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.label}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
