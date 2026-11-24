/**
 * Development-only endpoint backing the "local" storage driver.
 *
 * POST: multipart upload matching a presigned "upload" signature (key, content
 * type, size limit, expiry). GET: download matching a presigned "get" signature.
 * Refuses to run unless STORAGE_DRIVER=local and NODE_ENV is not production.
 */
import { NextResponse } from "next/server";
import { getStorage, verifyLocalSignature } from "@/lib/storage";

function enabled(): boolean {
  return process.env.STORAGE_DRIVER === "local" && process.env.NODE_ENV !== "production";
}

function expired(exp: string): boolean {
  const n = Number(exp);
  return !Number.isFinite(n) || n < Math.floor(Date.now() / 1000);
}

export async function POST(req: Request) {
  if (!enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const declared = Number(req.headers.get("content-length") ?? "0");
  const form = await req.formData();
  const key = String(form.get("key") ?? "");
  const contentType = String(form.get("Content-Type") ?? "");
  const maxBytes = String(form.get("maxBytes") ?? "");
  const exp = String(form.get("exp") ?? "");
  const sig = String(form.get("sig") ?? "");
  const file = form.get("file");

  if (!verifyLocalSignature(["upload", key, contentType, maxBytes, exp], sig) || expired(exp)) {
    return NextResponse.json({ error: "Invalid or expired upload signature" }, { status: 403 });
  }
  if (!(file instanceof Blob)) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  if (file.size > Number(maxBytes) || declared > Number(maxBytes) + 64 * 1024) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }
  await getStorage().put(key, Buffer.from(await file.arrayBuffer()), contentType);
  return new NextResponse(null, { status: 204 });
}

export async function GET(req: Request) {
  if (!enabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const url = new URL(req.url);
  const key = url.searchParams.get("key") ?? "";
  const exp = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  const name = url.searchParams.get("name") ?? "";
  if (!verifyLocalSignature(["get", key, exp, name], sig) || expired(exp)) {
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 403 });
  }
  const storage = getStorage();
  const head = await storage.head(key);
  if (!head) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await storage.get(key);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": head.contentType ?? "application/octet-stream",
      "content-disposition": `attachment${name ? `; filename="${name}"` : ""}`,
      "x-content-type-options": "nosniff",
    },
  });
}
