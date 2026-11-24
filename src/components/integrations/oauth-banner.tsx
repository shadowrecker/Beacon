"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_state: "The connection request couldn't be verified. Start the connection again.",
  expired: "The connection request expired. Start the connection again.",
  session_mismatch: "You were signed in as a different user when the provider sent you back. Sign in with the account that started the connection and try again.",
  cookie_missing: "The connection was started in a different browser or session. Start it again from this browser.",
  access_denied: "Access wasn't granted on the provider's side.",
  not_configured: "This provider isn't configured on this Beacon deployment yet.",
  exchange_failed: "The provider didn't accept the authorization. Try connecting again.",
  invalid_request: "Some connection details were missing or invalid. Check them and try again.",
  forbidden: "You don't have permission to connect integrations in this workspace.",
  limit_reached: "Your plan's integration limit has been reached. Upgrade or disconnect another integration first.",
};

/** Shows the outcome of an OAuth round trip (?connected=… or ?oauth_error=…) and clears the query. */
export function OAuthBanner({ providerName }: { providerName: (provider: string) => string }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const connected = params.get("connected");
  const error = params.get("oauth_error");
  const provider = params.get("provider");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [connected, error]);

  if (dismissed || (!connected && !error)) return null;
  const success = !!connected;
  const name = providerName((connected ?? provider ?? "").toUpperCase());
  const message = success
    ? `${name || "The integration"} is connected. The first sync has started and documents will appear in the target project.`
    : `${name ? `${name}: ` : ""}${ERROR_MESSAGES[error ?? ""] ?? "The connection didn't complete. Try again."}`;

  const close = () => {
    setDismissed(true);
    router.replace(pathname);
  };

  return (
    <div
      role={success ? "status" : "alert"}
      className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${success ? "border-green-500/40 bg-green-500/10" : "border-destructive/40 bg-destructive/10"}`}
    >
      {success ? <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600" aria-hidden /> : <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-destructive" aria-hidden />}
      <p className="flex-1">{message}</p>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={close} aria-label="Dismiss">
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}
