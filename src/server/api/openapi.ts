/**
 * OpenAPI 3.1 document generated from the REST route definitions (routes.ts),
 * so the published spec, the docs page and the router can never drift.
 * JSON Schema 2020-12 (zod's default target) is OpenAPI 3.1's schema dialect.
 */
import { z } from "zod";
import { API_SCOPES, MAX_RATE_LIMIT, SCOPE_DESCRIPTIONS } from "./auth";
import { ROUTES, type RouteDefinition } from "./routes";

type JsonSchema = Record<string, unknown>;

export interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  security: Array<Record<string, string[]>>;
  "x-required-scope": string;
  parameters: OpenApiParameter[];
  requestBody?: { required: boolean; content: { "application/json": { schema: JsonSchema } } };
  responses: Record<string, { description: string; content?: { "application/json": { schema: JsonSchema } }; headers?: Record<string, unknown> }>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, JsonSchema>;
    responses: Record<string, unknown>;
  };
}

const ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
        details: {
          type: "array",
          items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } },
        },
      },
    },
  },
};

const errorRef = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

/** Convert a zod schema, hoisting named sub-schemas into components. */
function toSchema(schema: z.ZodType, io: "input" | "output", components: Record<string, JsonSchema>): JsonSchema {
  const out = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema & { $defs?: Record<string, JsonSchema> };
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === "$ref" && typeof v === "string") o[k] = v.replace("#/$defs/", "#/components/schemas/");
        else o[k] = rewrite(v);
      }
      return o;
    }
    return value;
  };
  for (const [name, def] of Object.entries(out.$defs ?? {})) components[name] = rewrite(def) as JsonSchema;
  const { $schema: _schema, $defs: _defs, ...rest } = out;
  void _schema;
  void _defs;
  return rewrite(rest) as JsonSchema;
}

function parametersOf(route: RouteDefinition, components: Record<string, JsonSchema>): OpenApiParameter[] {
  const params: OpenApiParameter[] = [];
  for (const [where, schema] of [
    ["path", route.params],
    ["query", route.query],
  ] as const) {
    if (!schema) continue;
    const js = toSchema(schema, "input", components) as { properties?: Record<string, JsonSchema>; required?: string[] };
    for (const [name, prop] of Object.entries(js.properties ?? {})) {
      const { description, ...propSchema } = prop as JsonSchema & { description?: string };
      params.push({
        name,
        in: where,
        required: where === "path" || (js.required ?? []).includes(name),
        ...(description ? { description } : {}),
        schema: propSchema,
      });
    }
  }
  return params;
}

let cached: OpenApiDocument | null = null;

export function buildOpenApiDocument(): OpenApiDocument {
  if (cached) return cached;
  const components: Record<string, JsonSchema> = { Error: ERROR_SCHEMA };
  const paths: OpenApiDocument["paths"] = {};

  for (const route of ROUTES as readonly RouteDefinition[]) {
    const status = String(route.status ?? 200);
    const op: OpenApiOperation = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      tags: [route.tag],
      security: [{ bearerAuth: [] }],
      "x-required-scope": route.scope,
      parameters: parametersOf(route, components),
      responses: {
        [status]: {
          description: status === "201" ? "Created" : status === "202" ? "Accepted for asynchronous processing" : "OK",
          content: { "application/json": { schema: toSchema(route.response, "output", components) } },
        },
        ...(route.body || route.params || route.query ? { "400": { $ref: "#/components/responses/BadRequest" } } : {}),
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        ...(route.params ? { "404": { $ref: "#/components/responses/NotFound" } } : {}),
        "429": { $ref: "#/components/responses/RateLimited" },
        "500": { $ref: "#/components/responses/ServerError" },
      } as unknown as OpenApiOperation["responses"],
    };
    if (route.body) {
      op.requestBody = { required: true, content: { "application/json": { schema: toSchema(route.body, "input", components) } } };
    }
    (paths[route.path] ??= {})[route.method.toLowerCase()] = op;
  }

  cached = {
    openapi: "3.1.0",
    info: {
      title: "Beacon API",
      version: "1.0.0",
      description: [
        "Programmatic access to a Beacon workspace: projects, documents, syntheses, recommendations and voice insights.",
        "",
        "Authenticate with an API key created under Developer → API keys, sent as `Authorization: Bearer bk_live_…`.",
        "Every key belongs to one workspace and can only see that workspace's data. Each endpoint requires one scope (`x-required-scope`).",
        `Requests are rate limited per key (the key's limit, at most ${MAX_RATE_LIMIT} per minute); a 429 response includes Retry-After.`,
        "Lists are paginated with `limit` and `cursor`; pass the returned `nextCursor` to get the next page.",
      ].join("\n"),
    },
    servers: [{ url: `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/api/v1` }],
    tags: [
      { name: "Projects", description: "Workspaces for a body of customer feedback." },
      { name: "Documents", description: "Customer feedback added to a project." },
      { name: "Syntheses", description: "AI analyses of a project's documents." },
      { name: "Recommendations", description: "Product recommendations derived from syntheses." },
      { name: "Voice", description: "Voice recordings and their AI insights." },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: `API key. Available scopes: ${API_SCOPES.map((s) => `${s} (${SCOPE_DESCRIPTIONS[s]})`).join("; ")}.`,
        },
      },
      schemas: components,
      responses: {
        BadRequest: errorRef("The request was invalid"),
        Unauthorized: errorRef("Missing, invalid, revoked or expired API key"),
        Forbidden: errorRef("The API key lacks the required scope, or a plan limit was reached"),
        NotFound: errorRef("The resource does not exist in this workspace"),
        RateLimited: {
          ...errorRef("Rate limit exceeded"),
          headers: { "Retry-After": { description: "Seconds until the limit resets", schema: { type: "integer" } } },
        },
        ServerError: errorRef("Unexpected server error"),
      },
    },
  };
  return cached;
}
