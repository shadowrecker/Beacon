/**
 * REST API v1 route definitions: the single source of truth for routing, scope
 * enforcement, input validation, the OpenAPI document and the SDK contract.
 *
 * Tenancy: every handler scopes every query to `key.orgId`. Project-scoped
 * routes resolve the project with `{ id, orgId: key.orgId }` first and then
 * look up children with `projectId: project.id`, so an ID from another org is
 * indistinguishable from a nonexistent one (404).
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { getStorage, keyBelongsToProject } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { enqueue, QUEUE } from "../jobs/queues";
import { createDocumentFromText } from "../documents/ingest";
import { assertCanCreate, assertTokenBudget, BudgetExceededError } from "../usage/entitlements";
import type { ApiKeyPrincipal, ApiScope } from "./auth";
import { ApiError, conflict, notFound } from "./http";

// ---------------------------------------------------------------------------
// Definition types
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RouteContext<P, Q, B> {
  key: ApiKeyPrincipal;
  params: P;
  query: Q;
  body: B;
}

export interface RouteDefinition<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  /** OpenAPI-style template, e.g. "/projects/{projectId}". */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: "Projects" | "Documents" | "Syntheses" | "Recommendations" | "Voice";
  scope: ApiScope;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  status?: 200 | 201 | 202;
  handler(ctx: RouteContext<z.infer<P>, z.infer<Q>, z.infer<B>>): Promise<z.infer<R>>;
}

function defineRoute<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType>(
  def: RouteDefinition<P, Q, B, R>
): RouteDefinition<P, Q, B, R> {
  return def;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const idParam = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid ID");
const dateTime = z.string().meta({ format: "date-time" });
const nullableDateTime = z.string().nullable().meta({ format: "date-time" });

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25).meta({ description: "Page size (1-100)." }),
  cursor: z.string().max(64).optional().meta({ description: "`nextCursor` from the previous page." }),
});

/** Optional comma-separated enum filter in a query string, e.g. `status=PENDING,PROCESSING`. */
function statusList<const T extends readonly [string, ...string[]]>(values: T) {
  const pattern = new RegExp(`^(${values.join("|")})(,(${values.join("|")})){0,${values.length - 1}}$`);
  return z
    .string()
    .regex(pattern, `Use one or more of ${values.join(", ")}, separated by commas`)
    .transform((s) => [...new Set(s.split(","))] as Array<T[number]>)
    .optional();
}

function page<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}
function single<T extends z.ZodType>(item: T) {
  return z.object({ data: item });
}

export const ProjectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: dateTime,
    updatedAt: dateTime,
    counts: z.object({ documents: z.number().int(), syntheses: z.number().int(), recommendations: z.number().int() }),
  })
  .meta({ id: "Project" });

export const DocumentSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    type: z.enum(["TRANSCRIPT", "SUPPORT_TICKET", "NOTE", "CALL_RECORDING", "OTHER"]),
    source: z.string(),
    status: z.enum(["PENDING", "PROCESSING", "READY", "FAILED"]),
    mimeType: z.string().nullable(),
    fileSize: z.number().int().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: dateTime,
    updatedAt: dateTime,
    processedAt: nullableDateTime,
  })
  .meta({ id: "Document" });

export const DocumentDetailSchema = DocumentSchema.extend({ characterCount: z.number().int() }).meta({ id: "DocumentDetail" });

export const SynthesisSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    type: z.enum(["THEMES", "PAIN_POINTS", "FEATURE_REQUESTS", "FULL"]),
    status: z.enum(["PENDING", "PROCESSING", "READY", "FAILED"]),
    errorMessage: z.string().nullable(),
    themeCount: z.number().int(),
    createdAt: dateTime,
    startedAt: nullableDateTime,
    completedAt: nullableDateTime,
  })
  .meta({ id: "Synthesis" });

export const ThemeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"]),
    confidence: z.number(),
    citationCount: z.number().int(),
  })
  .meta({ id: "Theme" });

export const SynthesisDetailSchema = SynthesisSchema.extend({ themes: z.array(ThemeSchema) }).meta({ id: "SynthesisDetail" });

export const RecommendationSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    synthesisId: z.string().nullable(),
    title: z.string(),
    description: z.string(),
    impact: z.enum(["HIGH", "MEDIUM", "LOW"]),
    confidence: z.number(),
    status: z.enum(["DRAFT", "ACCEPTED", "REJECTED", "IMPLEMENTED"]),
    segments: z.array(z.string()),
    hasBrief: z.boolean(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .meta({ id: "Recommendation" });

export const VoiceInsightSchema = z
  .object({
    id: z.string(),
    recordingId: z.string(),
    summary: z.string(),
    keyPoints: z.array(z.unknown()),
    painPoints: z.array(z.unknown()),
    actionItems: z.array(z.unknown()),
    sentimentScore: z.number(),
    themes: z.array(z.string()),
    createdAt: dateTime,
  })
  .meta({ id: "VoiceInsight" });

export const VoiceRecordingSchema = z
  .object({
    id: z.string(),
    projectId: z.string().nullable(),
    title: z.string().nullable(),
    duration: z.number().int().meta({ description: "Length in seconds." }),
    status: z.enum(["RECORDING", "UPLOADING", "TRANSCRIBING", "ANALYZING", "READY", "FAILED"]),
    documentId: z.string().nullable(),
    recordedAt: dateTime,
    processedAt: nullableDateTime,
    createdAt: dateTime,
  })
  .meta({ id: "VoiceRecording" });

export const VoiceRecordingDetailSchema = VoiceRecordingSchema.extend({ insight: VoiceInsightSchema.nullable() }).meta({
  id: "VoiceRecordingDetail",
});

// ---------------------------------------------------------------------------
// Serializers and scoped loaders
// ---------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const jsonArray = (v: Prisma.JsonValue | null): unknown[] => (Array.isArray(v) ? v.slice(0, 50) : []);

async function requireProject(key: ApiKeyPrincipal, projectId: string) {
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId: key.orgId }, select: { id: true, orgId: true } });
  if (!project) throw notFound("Project");
  return project;
}

function paginate<T extends { id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

function cursorArgs(cursor: string | undefined): { cursor: { id: string } | undefined; skip: number } {
  return { cursor: cursor ? { id: cursor } : undefined, skip: cursor ? 1 : 0 };
}

const projectSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { documents: true, syntheses: true, recommendations: true } },
} as const;

function serializeProject(p: Prisma.ProjectGetPayload<{ select: typeof projectSelect }>): z.infer<typeof ProjectSchema> {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    counts: { documents: p._count.documents, syntheses: p._count.syntheses, recommendations: p._count.recommendations },
  };
}

const documentSelect = {
  id: true,
  projectId: true,
  title: true,
  type: true,
  source: true,
  status: true,
  mimeType: true,
  fileSize: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
  processingCompletedAt: true,
} as const;

function serializeDocument(d: Prisma.DocumentGetPayload<{ select: typeof documentSelect }>): z.infer<typeof DocumentSchema> {
  return {
    id: d.id,
    projectId: d.projectId,
    title: d.title,
    type: d.type,
    source: d.source,
    status: d.status,
    mimeType: d.mimeType,
    fileSize: d.fileSize,
    errorMessage: d.errorMessage ? clip(d.errorMessage, 500) : null,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    processedAt: isoOrNull(d.processingCompletedAt),
  };
}

const synthesisSelect = {
  id: true,
  projectId: true,
  type: true,
  status: true,
  errorMessage: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  _count: { select: { themes: true } },
} as const;

function serializeSynthesis(s: Prisma.SynthesisGetPayload<{ select: typeof synthesisSelect }>): z.infer<typeof SynthesisSchema> {
  return {
    id: s.id,
    projectId: s.projectId,
    type: s.type,
    status: s.status,
    errorMessage: s.errorMessage ? clip(s.errorMessage, 500) : null,
    themeCount: s._count.themes,
    createdAt: iso(s.createdAt),
    startedAt: isoOrNull(s.startedAt),
    completedAt: isoOrNull(s.completedAt),
  };
}

const recordingSelect = {
  id: true,
  projectId: true,
  title: true,
  duration: true,
  status: true,
  documentId: true,
  recordedAt: true,
  processedAt: true,
  createdAt: true,
} as const;

function serializeRecording(r: Prisma.VoiceRecordingGetPayload<{ select: typeof recordingSelect }>): z.infer<typeof VoiceRecordingSchema> {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    duration: r.duration,
    status: r.status,
    documentId: r.documentId,
    recordedAt: iso(r.recordedAt),
    processedAt: isoOrNull(r.processedAt),
    createdAt: iso(r.createdAt),
  };
}

const insightSelect = {
  id: true,
  recordingId: true,
  summary: true,
  keyPoints: true,
  painPoints: true,
  actionItems: true,
  sentimentScore: true,
  themes: true,
  createdAt: true,
} as const;

function serializeInsight(i: Prisma.VoiceInsightGetPayload<{ select: typeof insightSelect }>): z.infer<typeof VoiceInsightSchema> {
  return {
    id: i.id,
    recordingId: i.recordingId,
    summary: clip(i.summary, 5_000),
    keyPoints: jsonArray(i.keyPoints),
    painPoints: jsonArray(i.painPoints),
    actionItems: jsonArray(i.actionItems),
    sentimentScore: i.sentimentScore,
    themes: i.themes.slice(0, 50),
    createdAt: iso(i.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const projectParams = z.object({ projectId: idParam });

export const ROUTES = [
  defineRoute({
    method: "GET",
    path: "/projects",
    operationId: "listProjects",
    summary: "List projects",
    description: "Projects in the API key's workspace, most recently updated first.",
    tag: "Projects",
    scope: "projects:read",
    query: pageQuery,
    response: page(ProjectSchema),
    async handler({ key, query }) {
      const rows = await prisma.project.findMany({
        where: { orgId: key.orgId },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...cursorArgs(query.cursor),
        select: projectSelect,
      });
      const { items, nextCursor } = paginate(rows, query.limit);
      return { data: items.map(serializeProject), nextCursor };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/projects",
    operationId: "createProject",
    summary: "Create a project",
    tag: "Projects",
    scope: "projects:write",
    body: z
      .object({
        name: z.string().trim().min(1).max(200),
        description: z.string().trim().max(2000).optional(),
      })
      .strict(),
    response: single(ProjectSchema),
    status: 201,
    async handler({ key, body }) {
      await assertCanCreate(key.orgId, "projects");
      const project = await prisma.project.create({
        data: { name: body.name, description: body.description || null, orgId: key.orgId, userId: key.createdBy },
        select: projectSelect,
      });
      return { data: serializeProject(project) };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/projects/{projectId}",
    operationId: "getProject",
    summary: "Get a project",
    tag: "Projects",
    scope: "projects:read",
    params: projectParams,
    response: single(ProjectSchema),
    async handler({ key, params }) {
      const project = await prisma.project.findFirst({ where: { id: params.projectId, orgId: key.orgId }, select: projectSelect });
      if (!project) throw notFound("Project");
      return { data: serializeProject(project) };
    },
  }),

  defineRoute({
    method: "PATCH",
    path: "/projects/{projectId}",
    operationId: "updateProject",
    summary: "Update a project",
    tag: "Projects",
    scope: "projects:write",
    params: projectParams,
    body: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
      })
      .strict()
      .refine((b) => b.name !== undefined || b.description !== undefined, "Provide name or description"),
    response: single(ProjectSchema),
    async handler({ key, params, body }) {
      const project = await requireProject(key, params.projectId);
      const updated = await prisma.project.update({
        where: { id: project.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
        },
        select: projectSelect,
      });
      return { data: serializeProject(updated) };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/projects/{projectId}/documents",
    operationId: "listDocuments",
    summary: "List documents in a project",
    tag: "Documents",
    scope: "documents:read",
    params: projectParams,
    query: pageQuery.extend({
      status: statusList(["PENDING", "PROCESSING", "READY", "FAILED"] as const).meta({
        description: "Filter by processing status; comma-separate several, e.g. PENDING,PROCESSING.",
      }),
    }),
    response: page(DocumentSchema),
    async handler({ key, params, query }) {
      const project = await requireProject(key, params.projectId);
      const rows = await prisma.document.findMany({
        where: { projectId: project.id, ...(query.status ? { status: { in: query.status } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...cursorArgs(query.cursor),
        select: documentSelect,
      });
      const { items, nextCursor } = paginate(rows, query.limit);
      return { data: items.map(serializeDocument), nextCursor };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/projects/{projectId}/documents",
    operationId: "createDocument",
    summary: "Add a text document",
    description: "Adds customer feedback as plain text. The document is processed asynchronously; poll it until `status` is READY.",
    tag: "Documents",
    scope: "documents:write",
    params: projectParams,
    body: z
      .object({
        title: z.string().trim().min(1).max(300),
        text: z.string().min(1).max(1_000_000),
        type: z.enum(["TRANSCRIPT", "SUPPORT_TICKET", "NOTE", "CALL_RECORDING", "OTHER"]).default("NOTE"),
      })
      .strict(),
    response: single(DocumentSchema),
    status: 202,
    async handler({ key, params, body }) {
      const project = await requireProject(key, params.projectId);
      const { documentId } = await createDocumentFromText({
        projectId: project.id,
        title: body.title,
        type: body.type,
        source: "UPLOAD",
        text: body.text,
        mimeType: "text/plain",
        createdById: key.createdBy,
        metadata: { via: "api", apiKeyId: key.id },
      });
      const doc = await prisma.document.findFirst({ where: { id: documentId, projectId: project.id }, select: documentSelect });
      if (!doc) throw notFound("Document");
      return { data: serializeDocument(doc) };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/projects/{projectId}/documents/{documentId}",
    operationId: "getDocument",
    summary: "Get a document",
    tag: "Documents",
    scope: "documents:read",
    params: z.object({ projectId: idParam, documentId: idParam }),
    response: single(DocumentDetailSchema),
    async handler({ key, params }) {
      const project = await requireProject(key, params.projectId);
      const doc = await prisma.document.findFirst({
        where: { id: params.documentId, projectId: project.id },
        select: documentSelect,
      });
      if (!doc) throw notFound("Document");
      const [{ length }] = await prisma.$queryRaw<Array<{ length: number | null }>>`
        SELECT char_length("processedText")::int AS length FROM "documents" WHERE id = ${doc.id}`;
      return { data: { ...serializeDocument(doc), characterCount: length ?? 0 } };
    },
  }),

  defineRoute({
    method: "DELETE",
    path: "/projects/{projectId}/documents/{documentId}",
    operationId: "deleteDocument",
    summary: "Delete a document",
    description: "Deletes the document, its chunks and its stored file.",
    tag: "Documents",
    scope: "documents:write",
    params: z.object({ projectId: idParam, documentId: idParam }),
    response: single(z.object({ id: z.string(), deleted: z.literal(true) })),
    async handler({ key, params }) {
      const project = await requireProject(key, params.projectId);
      const doc = await prisma.document.findFirst({ where: { id: params.documentId, projectId: project.id }, select: { id: true, storageKey: true } });
      if (!doc) throw notFound("Document");
      await prisma.document.delete({ where: { id: doc.id } });
      if (doc.storageKey && keyBelongsToProject(doc.storageKey, project.id)) {
        await getStorage()
          .delete(doc.storageKey)
          .catch((err) => logger.warn("stored file cleanup failed", { documentId: doc.id, err }));
      }
      return { data: { id: doc.id, deleted: true as const } };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/projects/{projectId}/syntheses",
    operationId: "listSyntheses",
    summary: "List syntheses in a project",
    tag: "Syntheses",
    scope: "synthesis:read",
    params: projectParams,
    query: pageQuery,
    response: page(SynthesisSchema),
    async handler({ key, params, query }) {
      const project = await requireProject(key, params.projectId);
      const rows = await prisma.synthesis.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...cursorArgs(query.cursor),
        select: synthesisSelect,
      });
      const { items, nextCursor } = paginate(rows, query.limit);
      return { data: items.map(serializeSynthesis), nextCursor };
    },
  }),

  defineRoute({
    method: "POST",
    path: "/projects/{projectId}/syntheses",
    operationId: "runSynthesis",
    summary: "Start a synthesis",
    description: "Starts an asynchronous synthesis of the project's processed documents. Poll the synthesis until `status` is READY or FAILED.",
    tag: "Syntheses",
    scope: "synthesis:write",
    params: projectParams,
    body: z.object({ type: z.enum(["THEMES", "PAIN_POINTS", "FEATURE_REQUESTS", "FULL"]).default("FULL") }).strict(),
    response: single(SynthesisSchema),
    status: 202,
    async handler({ key, params, body }) {
      const project = await requireProject(key, params.projectId);
      const limited = await checkRateLimit(RATE_LIMITS.llm, `apikey:${key.id}`);
      if (!limited.allowed) {
        throw new ApiError(429, "RATE_LIMITED", "Too many synthesis requests. Try again shortly.");
      }
      const inFlight = await prisma.synthesis.findFirst({
        where: { projectId: project.id, status: { in: ["PENDING", "PROCESSING"] } },
        select: { id: true },
      });
      if (inFlight) throw conflict("A synthesis is already running for this project");
      const ready = await prisma.document.count({ where: { projectId: project.id, status: "READY" } });
      if (ready === 0) throw new ApiError(422, "NO_DOCUMENTS", "The project has no processed documents to synthesize");
      try {
        await assertTokenBudget(key.orgId);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw new ApiError(403, "BUDGET_EXCEEDED", err.message);
        throw err;
      }
      const synthesis = await prisma.synthesis.create({
        data: { projectId: project.id, type: body.type, status: "PENDING", createdById: key.createdBy },
        select: synthesisSelect,
      });
      await enqueue(QUEUE.SYNTHESIS, { synthesisId: synthesis.id }, { jobId: `syn_${synthesis.id}` });
      return { data: serializeSynthesis(synthesis) };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/projects/{projectId}/syntheses/{synthesisId}",
    operationId: "getSynthesis",
    summary: "Get a synthesis with its themes",
    tag: "Syntheses",
    scope: "synthesis:read",
    params: z.object({ projectId: idParam, synthesisId: idParam }),
    response: single(SynthesisDetailSchema),
    async handler({ key, params }) {
      const project = await requireProject(key, params.projectId);
      const s = await prisma.synthesis.findFirst({ where: { id: params.synthesisId, projectId: project.id }, select: synthesisSelect });
      if (!s) throw notFound("Synthesis");
      const themes = await prisma.theme.findMany({
        where: { synthesisId: s.id },
        orderBy: { confidenceScore: "desc" },
        take: 100,
        select: { id: true, name: true, description: true, sentiment: true, confidenceScore: true, _count: { select: { citations: true } } },
      });
      return {
        data: {
          ...serializeSynthesis(s),
          themes: themes.map((t) => ({
            id: t.id,
            name: t.name,
            description: clip(t.description, 5_000),
            sentiment: t.sentiment,
            confidence: t.confidenceScore,
            citationCount: t._count.citations,
          })),
        },
      };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/projects/{projectId}/recommendations",
    operationId: "listRecommendations",
    summary: "List recommendations in a project",
    tag: "Recommendations",
    scope: "recommendations:read",
    params: projectParams,
    query: pageQuery.extend({
      status: statusList(["DRAFT", "ACCEPTED", "REJECTED", "IMPLEMENTED"] as const).meta({
        description: "Filter by status; comma-separate several, e.g. DRAFT,ACCEPTED.",
      }),
    }),
    response: page(RecommendationSchema),
    async handler({ key, params, query }) {
      const project = await requireProject(key, params.projectId);
      const rows = await prisma.recommendation.findMany({
        where: { projectId: project.id, ...(query.status ? { status: { in: query.status } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...cursorArgs(query.cursor),
        select: {
          id: true,
          projectId: true,
          synthesisId: true,
          title: true,
          description: true,
          impact: true,
          confidence: true,
          status: true,
          segments: true,
          briefGeneratedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const { items, nextCursor } = paginate(rows, query.limit);
      return {
        data: items.map((r) => ({
          id: r.id,
          projectId: r.projectId,
          synthesisId: r.synthesisId,
          title: r.title,
          description: clip(r.description, 4_000),
          impact: r.impact,
          confidence: r.confidence,
          status: r.status,
          segments: r.segments.slice(0, 20),
          hasBrief: r.briefGeneratedAt !== null,
          createdAt: iso(r.createdAt),
          updatedAt: iso(r.updatedAt),
        })),
        nextCursor,
      };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/projects/{projectId}/voice/insights",
    operationId: "listVoiceInsights",
    summary: "List voice insights in a project",
    tag: "Voice",
    scope: "voice:read",
    params: projectParams,
    query: pageQuery,
    response: page(VoiceInsightSchema),
    async handler({ key, params, query }) {
      const project = await requireProject(key, params.projectId);
      const rows = await prisma.voiceInsight.findMany({
        where: { recording: { projectId: project.id } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...cursorArgs(query.cursor),
        select: insightSelect,
      });
      const { items, nextCursor } = paginate(rows, query.limit);
      return { data: items.map(serializeInsight), nextCursor };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/voice/recordings",
    operationId: "listVoiceRecordings",
    summary: "List voice recordings",
    description: "Recordings attached to projects in the API key's workspace.",
    tag: "Voice",
    scope: "voice:read",
    query: pageQuery.extend({ projectId: idParam.optional().meta({ description: "Only recordings in this project." }) }),
    response: page(VoiceRecordingSchema),
    async handler({ key, query }) {
      const projectFilter = query.projectId ? { projectId: (await requireProject(key, query.projectId)).id } : {};
      const rows = await prisma.voiceRecording.findMany({
        where: { project: { orgId: key.orgId }, ...projectFilter },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...cursorArgs(query.cursor),
        select: recordingSelect,
      });
      const { items, nextCursor } = paginate(rows, query.limit);
      return { data: items.map(serializeRecording), nextCursor };
    },
  }),

  defineRoute({
    method: "GET",
    path: "/voice/recordings/{recordingId}",
    operationId: "getVoiceRecording",
    summary: "Get a voice recording and its insight",
    tag: "Voice",
    scope: "voice:read",
    params: z.object({ recordingId: idParam }),
    response: single(VoiceRecordingDetailSchema),
    async handler({ key, params }) {
      const rec = await prisma.voiceRecording.findFirst({
        where: { id: params.recordingId, project: { orgId: key.orgId } },
        select: { ...recordingSelect, insight: { select: insightSelect } },
      });
      if (!rec) throw notFound("Recording");
      return { data: { ...serializeRecording(rec), insight: rec.insight ? serializeInsight(rec.insight) : null } };
    },
  }),
] as const;

export type ApiRoute = (typeof ROUTES)[number];

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

interface CompiledRoute {
  route: RouteDefinition;
  regex: RegExp;
  names: string[];
}

const compiled: CompiledRoute[] = (ROUTES as readonly RouteDefinition[]).map((route) => {
  const names: string[] = [];
  const pattern = route.path
    .split("/")
    .map((seg) => {
      const m = /^\{(\w+)\}$/.exec(seg);
      if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(m[1]);
      return "([^/]+)";
    })
    .join("/");
  return { route, regex: new RegExp(`^${pattern}/?$`), names };
});

export type RouteMatch =
  | { kind: "match"; route: RouteDefinition; params: Record<string, string> }
  | { kind: "method_not_allowed"; allow: HttpMethod[] }
  | { kind: "not_found" };

export function matchRoute(method: string, path: string): RouteMatch {
  const allow: HttpMethod[] = [];
  for (const c of compiled) {
    const m = c.regex.exec(path);
    if (!m) continue;
    if (c.route.method !== method) {
      allow.push(c.route.method);
      continue;
    }
    const params: Record<string, string> = {};
    c.names.forEach((n, i) => {
      try {
        params[n] = decodeURIComponent(m[i + 1]);
      } catch {
        params[n] = "";
      }
    });
    return { kind: "match", route: c.route, params };
  }
  return allow.length ? { kind: "method_not_allowed", allow } : { kind: "not_found" };
}
