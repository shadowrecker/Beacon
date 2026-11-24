/**
 * Browser instrumentation (Next 15.3+): Sentry error reporting and PostHog
 * product analytics. Both are no-ops unless their public keys are configured.
 */
import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { scrubEvent } from "./lib/sentry-scrub";

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    beforeSend: scrubEvent,
  });
}

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    // Pageviews are captured on route change by the PostHog provider.
    capture_pageview: false,
    capture_pageleave: true,
    person_profiles: "identified_only",
    // Never record input values: users type customer data into Beacon.
    mask_all_text: false,
    session_recording: { maskAllInputs: true },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
