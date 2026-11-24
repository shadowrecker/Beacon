"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { useUser } from "@clerk/nextjs";

function Tracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useUser();

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY || !pathname) return;
    // Path only (no query string): queries can contain search terms.
    posthog.capture("$pageview", { $current_url: window.location.origin + pathname });
  }, [pathname, searchParams]);

  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    if (user?.id) posthog.identify(user.id);
    else posthog.reset();
  }, [user?.id]);

  return null;
}

/** App Router pageview capture (posthog-js does not capture client navigations by itself). */
export function PostHogPageviews() {
  return (
    <Suspense fallback={null}>
      <Tracker />
    </Suspense>
  );
}
