"use client";

/**
 * Client-side store for the active organization. The tRPC link sends it as the
 * `x-org-id` header; the server verifies membership on every request, so this
 * value is a preference, never an authorization decision.
 */
import { useSyncExternalStore } from "react";

const KEY = "beacon.activeOrgId";
const listeners = new Set<() => void>();

export function getActiveOrgId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(KEY);
}

export function setActiveOrgId(orgId: string | null): void {
  if (typeof window === "undefined") return;
  if (orgId) window.localStorage.setItem(KEY, orgId);
  else window.localStorage.removeItem(KEY);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useActiveOrgId(): string | null {
  return useSyncExternalStore(subscribe, getActiveOrgId, () => null);
}
