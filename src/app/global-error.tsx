"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/** Last-resort boundary when the root layout itself fails (renders its own <html>). */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "6rem 1.5rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600 }}>Beacon is temporarily unavailable</h1>
        <p style={{ color: "#555", margin: "1rem 0" }}>
          An unexpected error occurred{error.digest ? ` (reference ${error.digest})` : ""}.
        </p>
        <button type="button" onClick={reset} style={{ padding: "0.5rem 1rem", borderRadius: 6, border: "1px solid #ccc" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
