"use client";

/**
 * Minimal accessible toast system (no dependency).
 * `toast.success("Saved")`, `toast.error("Failed")`; mount <Toaster/> once.
 */
import { useSyncExternalStore } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Kind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: Kind;
  message: string;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(kind: Kind, message: string, durationMs = kind === "error" ? 7000 : 4000) {
  const id = nextId++;
  items = [...items, { id, kind, message }].slice(-5);
  emit();
  setTimeout(() => dismiss(id), durationMs);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (m: string) => push("success", m),
  error: (m: string) => push("error", m),
  info: (m: string) => push("info", m),
};

const EMPTY: ToastItem[] = [];

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => items,
    () => EMPTY
  );
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2" aria-live="polite" role="region" aria-label="Notifications">
      {list.map((t) => {
        const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? AlertCircle : Info;
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded-lg border bg-background p-4 text-sm shadow-lg",
              t.kind === "error" && "border-destructive/40",
              t.kind === "success" && "border-green-500/40"
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 h-4 w-4 flex-shrink-0",
                t.kind === "error" ? "text-destructive" : t.kind === "success" ? "text-green-600" : "text-primary"
              )}
            />
            <p className="flex-1 text-foreground">{t.message}</p>
            <button type="button" onClick={() => dismiss(t.id)} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss notification">
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
