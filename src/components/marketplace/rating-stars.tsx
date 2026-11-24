"use client";

import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/** Read-only star rating with an accessible label. */
export function RatingStars({ value, count, size = "sm" }: { value: number; count?: number; size?: "sm" | "md" }) {
  const rounded = Math.round(value * 2) / 2;
  const cls = size === "md" ? "h-5 w-5" : "h-4 w-4";
  return (
    <span className="inline-flex items-center gap-1" role="img" aria-label={`${value.toFixed(1)} out of 5${count !== undefined ? `, ${count} review${count === 1 ? "" : "s"}` : ""}`}>
      <span className="inline-flex" aria-hidden>
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={cn(cls, n <= rounded ? "fill-yellow-400 text-yellow-400" : n - 0.5 === rounded ? "fill-yellow-400/50 text-yellow-400" : "text-muted-foreground/40")}
          />
        ))}
      </span>
      {count !== undefined && (
        <span className="text-xs text-muted-foreground" aria-hidden>
          {count > 0 ? `${value.toFixed(1)} (${count})` : "No reviews"}
        </span>
      )}
    </span>
  );
}

/** Keyboard-accessible star picker (a radio group). */
export function StarPicker({ value, onChange, name, disabled }: { value: number; onChange: (n: number) => void; name: string; disabled?: boolean }) {
  return (
    <fieldset className="flex items-center gap-1" disabled={disabled}>
      <legend className="sr-only">Rating</legend>
      {[1, 2, 3, 4, 5].map((n) => (
        <label key={n} className="cursor-pointer rounded focus-within:ring-2 focus-within:ring-ring">
          <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} className="sr-only" />
          <Star className={cn("h-6 w-6", n <= value ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/50")} aria-hidden />
          <span className="sr-only">
            {n} star{n === 1 ? "" : "s"}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
