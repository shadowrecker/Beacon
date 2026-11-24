/**
 * Public REST API v1 (catch-all). Every endpoint, its scope and its schemas are
 * defined in src/server/api/routes.ts; GET /api/v1/openapi.json serves the
 * OpenAPI document generated from the same definitions. Authenticated by API
 * key (the Clerk middleware treats /api/v1/* as public).
 */
import { handleApiRequest } from "@/server/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleApiRequest(req);
}

export function POST(req: Request): Promise<Response> {
  return handleApiRequest(req);
}

export function PATCH(req: Request): Promise<Response> {
  return handleApiRequest(req);
}

export function DELETE(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
