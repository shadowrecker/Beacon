"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "beacon.installPrompt.dismissed";

function isStandalone(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** Offers "Install app" (Chrome/Edge/Android) or Add-to-Home-Screen steps (iOS Safari). */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      dismissed = false;
    }
    if (dismissed || isStandalone()) return;
    setHidden(false);
    if (isIosSafari()) setShowIosHint(true);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* not remembered */
    }
  };

  if (hidden || (!deferred && !showIosHint)) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/50 p-3 text-sm">
      <Download className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
      <p className="flex-1">
        {deferred ? "Install Beacon for one-tap recording." : "Install Beacon: tap Share, then “Add to Home Screen”."}
      </p>
      {deferred && (
        <Button
          size="sm"
          onClick={async () => {
            await deferred.prompt();
            const choice = await deferred.userChoice;
            setDeferred(null);
            if (choice.outcome === "accepted") setHidden(true);
          }}
        >
          Install
        </Button>
      )}
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={dismiss} aria-label="Dismiss install suggestion">
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
