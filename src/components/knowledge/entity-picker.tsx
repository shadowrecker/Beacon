"use client";

import { useEffect, useId, useState } from "react";
import { X } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EntityTypeBadge, type EntitySummary } from "./entity-card";

/** Pick one entity by searching names. */
export function EntityPicker({ label, value, onChange }: { label: string; value: EntitySummary | null; onChange: (e: EntitySummary | null) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const results = trpc.knowledge.listEntities.useQuery({ search, limit: 8 }, { enabled: !value && search.length >= 2 });

  if (value) {
    return (
      <div className="space-y-1.5">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            {value.name} <EntityTypeBadge type={value.type} />
          </span>
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange(null)}>
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    );
  }

  const items = results.data?.items ?? [];
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type at least 2 characters" maxLength={200} autoComplete="off" />
      {search.length >= 2 && (
        <div className="rounded-md border" aria-live="polite">
          {results.isLoading ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
          ) : results.isError ? (
            <p className="px-3 py-2 text-sm text-destructive">{results.error.message}</p>
          ) : items.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No matching entities</p>
          ) : (
            <ul>
              {items.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    onClick={() => {
                      onChange(e);
                      setText("");
                      setSearch("");
                    }}
                  >
                    <span>{e.name}</span>
                    <EntityTypeBadge type={e.type} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
