/**
 * GET /api/integrations/oauth/callback?code=&state=
 *
 * Public in middleware (the provider redirects here), so this handler verifies
 * everything itself: the state's HMAC signature and expiry, the flow cookie's
 * signature and nonce, and that the signed-in Clerk user is the user who started
 * the flow. Only then is the code exchanged server-side and the encrypted tokens
 * stored. Always redirects to /integrations.
 */
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { appUrl } from "@/server/integrations/oauth";
import { completeOAuth, FLOW_COOKIE_PATH } from "@/server/integrations/oauth-flow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId: clerkId } = await auth();
  const user = clerkId ? await prisma.user.findUnique({ where: { clerkId }, select: { id: true } }) : null;

  const result = await completeOAuth({
    userId: user?.id ?? null,
    params: req.nextUrl.searchParams,
    readCookie: (name) => req.cookies.get(name)?.value,
  });

  const res = NextResponse.redirect(new URL(result.redirectPath, appUrl()));
  if (result.clearCookie) {
    res.cookies.set(result.clearCookie, "", { httpOnly: true, sameSite: "lax", secure: appUrl().startsWith("https://"), path: FLOW_COOKIE_PATH, maxAge: 0 });
  }
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}
