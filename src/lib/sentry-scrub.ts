/**
 * Strip PII before events leave the process: request bodies, cookies, auth
 * headers, and user email. Customer content must never reach Sentry.
 */
import type { ErrorEvent } from "@sentry/nextjs";

export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      for (const h of ["authorization", "cookie", "x-api-key"]) delete event.request.headers[h];
    }
  }
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  return event;
}
