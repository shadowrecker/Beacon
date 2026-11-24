/**
 * Server-to-server admin path: change an organization's plan. The
 * plan is writable only by billing/support, never through the org API.
 *
 *   POST /api/admin/orgs/:orgId/plan
 *   Authorization: Bearer $ADMIN_API_TOKEN
 *   {"plan": "FREE" | "TEAM" | "ENTERPRISE"}
 *
 * Disabled (404) unless ADMIN_API_TOKEN is configured. The token is compared in
 * constant time (over SHA-256 digests, so its length doesn't leak either).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sha256Hex, timingSafeEqualStr } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ plan: z.enum(["FREE", "TEAM", "ENTERPRISE"]) }).strict();
const ORG_ID = /^[a-z0-9]{10,40}$/i;
const MAX_BODY_BYTES = 1_024;

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqualStr(sha256Hex(match[1].trim()), sha256Hex(token));
}

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!authorized(req, token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }

  const { orgId } = await params;
  if (!ORG_ID.test(orgId)) return NextResponse.json({ error: "Organization not found" }, { status: 404 });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Expected {"plan": "FREE" | "TEAM" | "ENTERPRISE"}' }, { status: 400 });
  }

  const existing = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, plan: true } });
  if (!existing) return NextResponse.json({ error: "Organization not found" }, { status: 404 });

  const org = await prisma.organization.update({
    where: { id: orgId },
    data: { plan: parsed.data.plan },
    select: { id: true, plan: true, updatedAt: true },
  });
  logger.info("organization plan changed via admin API", { orgId, from: existing.plan, to: org.plan });
  return NextResponse.json({ id: org.id, plan: org.plan, previousPlan: existing.plan, updatedAt: org.updatedAt });
}
