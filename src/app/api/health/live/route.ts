import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe: the process is up and serving requests. */
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}
