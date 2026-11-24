"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";

/** Remove all caches the service worker created (called on sign-out). */
export async function clearServiceWorkerCaches(): Promise<void> {
  if (typeof caches !== "undefined") {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
  navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_CACHES" });
}

/**
 * Registers the service worker in production only (in development it would
 * serve stale HMR assets), and clears every cache when the session ends so a
 * shared device never shows the previous user's pages. The worker itself never
 * caches API responses; see public/sw.js.
 */
export function ServiceWorkerRegistrar() {
  const { isLoaded, isSignedIn } = useAuth();
  const wasSignedIn = useRef<boolean | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (wasSignedIn.current === true && !isSignedIn) {
      void clearServiceWorkerCaches();
    }
    wasSignedIn.current = Boolean(isSignedIn);
  }, [isLoaded, isSignedIn]);

  return null;
}
