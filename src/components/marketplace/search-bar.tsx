"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Search input that reports its value after the user pauses typing. */
export function SearchBar({ onSearch, delayMs = 300 }: { onSearch: (q: string) => void; delayMs?: number }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const t = setTimeout(() => onSearch(value.trim()), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs, onSearch]);
  return (
    <div className="relative w-full sm:max-w-sm">
      <Label htmlFor="marketplace-search" className="sr-only">
        Search connectors
      </Label>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id="marketplace-search"
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search connectors"
        maxLength={100}
        className="pl-9"
      />
    </div>
  );
}
