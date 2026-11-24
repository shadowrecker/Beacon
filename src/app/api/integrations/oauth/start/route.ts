/**
 * GET /api/integrations/oauth/start?provider=&projectId=[&subdomain=&environment=&region=]
 *
 * Authenticated (middleware). Requires integrations:manage in the project's org.
 * Sets a short-lived, httpOnly, SameSite=Lax flow cookie bound to the user and
 * redirects to the provider's consent screen with a signed state (+ PKCE where
 * supported). Failures redirect back to /integrations with an error code.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { appUrl, OAuthFlowError } from "@/server/integrations/oauth";
import { beginOAuth, errorRedirect } from "@/server/integrations/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider")?.toUpperCase() ?? undefined;
  const { userId: clerkId } = await auth();
  const user = clerkId ? await prisma.user.findUnique({ where: { clerkId }, select: { id: true } }) : null;
  if (!user) return NextResponse.redirect(new URL(errorRedirect("session_mismatch", provider), appUrl()));

  try {
    const { redirectUrl, cookie } = await beginOAuth({ userId: user.id, params: req.nextUrl.searchParams });
    const res = NextResponse.redirect(redirectUrl);
    res.cookies.set(cookie.name, cookie.value, {
      httpOnly: true,
      sameSite: "lax",
      secure: appUrl().startsWith("https://"),
      path: cookie.path,
      maxAge: cookie.maxAgeSec,
    });
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (err) {
    const code = err instanceof OAuthFlowError ? err.code : "exchange_failed";
    if (!(err instanceof OAuthFlowError)) logger.error("oauth start failed", { provider, err });
    return NextResponse.redirect(new URL(errorRedirect(code, provider), appUrl()));
  }
}
