import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Everything requires a signed-in user except the routes below.
 *
 * - /api/webhooks/*   verified by signature (svix) instead of a session
 * - /api/v1/*         public REST API, authenticated by API key
 * - /api/health/*     liveness/readiness probes
 * - /api/storage/local  dev-only signed URLs (HMAC-verified per request)
 * - /api/admin/*      server-to-server admin path (bearer token)
 * - /api/integrations/oauth/callback  OAuth redirect (state-verified)
 * - /invite/*         invite landing page shows sign-in when needed
 */
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/invite(.*)",
  "/api/webhooks/(.*)",
  "/api/v1/(.*)",
  "/api/health(.*)",
  "/api/storage/local",
  "/api/admin/(.*)",
  "/api/integrations/oauth/callback",
  "/manifest.json",
  "/sw.js",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
