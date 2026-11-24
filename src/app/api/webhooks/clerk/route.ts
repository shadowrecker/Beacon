/**
 * Clerk webhook: the authoritative source for user lifecycle.
 *
 * - user.created / user.updated -> upsert the Beacon user (+ personal org)
 * - user.deleted -> erase the user's data and stored objects (GDPR)
 *
 * Requests are verified with svix using CLERK_WEBHOOK_SECRET.
 */
import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { getStorage, projectPrefix } from "@/lib/storage";
import { deleteUserData, upsertUserFromClerk } from "@/server/auth/provision";

const emailSchema = z.object({ id: z.string(), email_address: z.string() });
const userSchema = z.object({
  id: z.string(),
  email_addresses: z.array(emailSchema).default([]),
  primary_email_address_id: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  image_url: z.string().nullable().optional(),
});
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user.created"), data: userSchema }),
  z.object({ type: z.literal("user.updated"), data: userSchema }),
  z.object({ type: z.literal("user.deleted"), data: z.object({ id: z.string().optional(), deleted: z.boolean().optional() }) }),
]);

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    logger.error("CLERK_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const body = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };

  let raw: unknown;
  try {
    raw = new Webhook(secret).verify(body, headers);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) {
    // Unhandled event types are acknowledged so Clerk does not retry them.
    return NextResponse.json({ ok: true, ignored: true });
  }

  const event = parsed.data;
  try {
    if (event.type === "user.created" || event.type === "user.updated") {
      const u = event.data;
      const primary = u.email_addresses.find((e) => e.id === u.primary_email_address_id) ?? u.email_addresses[0];
      await upsertUserFromClerk({
        clerkId: u.id,
        email: primary?.email_address.toLowerCase() ?? null,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || null,
        avatarUrl: u.image_url ?? null,
      });
    } else if (event.type === "user.deleted" && event.data.id) {
      const { deletedProjectIds } = await deleteUserData(event.data.id);
      const storage = getStorage();
      for (const projectId of deletedProjectIds) {
        await storage.deletePrefix(projectPrefix(projectId)).catch((err) =>
          logger.error("failed to purge project objects", { projectId, err })
        );
      }
    }
  } catch (err) {
    logger.error("clerk webhook handling failed", { type: event.type, err });
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
