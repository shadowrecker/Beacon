# Beacon engineering guide

How the codebase is put together and the rules every feature follows. Read this before changing server code.

## Architecture in one paragraph

Next.js 15 (App Router) serves the UI and a tRPC API (`/api/trpc`). Long-running work never runs in a request: a procedure writes a row in a non-terminal state and calls `enqueue(QUEUE.X, payload)`. The worker process (`src/workers/index.ts`) runs one BullMQ worker per queue, updates that same row to a terminal state, and emits domain events. Events go through a transactional outbox (`DomainEvent`) and are fanned out to subscribers (workflows, webhooks, notifications, team activity, coach, knowledge, outcomes). All data is org-scoped. Postgres with pgvector stores everything, including embeddings; Redis backs queues, rate limits and caches.

## Rules

### Tenancy and authorization
- Every project belongs to an organization (personal by default). Access is decided only by `src/server/auth/access.ts`:
  - `requireProjectAccess(ctx, projectId, permission)` for anything inside a project.
  - `requireOrgPermission(ctx, orgId, permission)` for org-level resources.
  - `orgProcedure` resolves the active org (from `input.orgId` or the `x-org-id` header) and verifies membership. Use `ctx.org.orgId` and `ctx.org.role`.
- **Foreign IDs.** After authorizing a project, every other ID in the input must be looked up *scoped to that project/org*, for example `findFirst({ where: { id, projectId: project.id } })`. Never `findUnique({ where: { id } })` on an input ID without a scope.
- Unauthorized and nonexistent resources both return `NOT_FOUND`. Use `FORBIDDEN` only when the caller can see the resource but lacks the role.
- Never accept tenant identifiers, credentials, recipients, sender addresses or URLs to fetch from request params when they can be derived server-side.

### Background jobs
- Queue names and payload schemas: `src/server/jobs/queues.ts`. Worker definitions: one file per queue in `src/workers/*-worker.ts`, registered in `src/workers/registry.ts`.
- Handlers use `defineWorker({ queue, handler, onFinalFailure })`.
  - Throw `NonRetryableError` for permanent problems.
  - `onFinalFailure` must move the owning row to FAILED with a user-presentable `errorMessage` (use `failureMessage(err)`).
- The producer creates the row; the worker updates **that same row**. Never create a second tracking row in the worker.
- Writes must be idempotent: a retried job must not duplicate rows. Replace a run's previous output in a transaction (delete-then-insert keyed by the row or run ID), or use upserts on the unique keys in the schema.
- Use deterministic `jobId`s where a double submit should be ignored.
- Work that has no natural row uses `JobRun` (`kind`, `status`, `output`, `errorMessage`). The client polls `job.get({ id })`.
- The maintenance worker fails rows stuck past `STUCK_AFTER_MS` (`src/server/jobs/maintenance.ts`).

### Domain events
- Emit with `emitEvent({ orgId, projectId, type, payload, actorUserId, causationDepth })` (`src/server/events/bus.ts`). Types and payload schemas live in `src/server/events/catalog.ts`.
- Subscribers live in `src/server/events/subscribers/*.ts` and must be idempotent.

### LLM and embeddings
- Only `src/server/ai/client.ts` talks to Anthropic. Use `generateObject({ feature, orgId, projectId, system, prompt, schema, tier, effort, maxTokens })`.
  - The zod schema is enforced by structured outputs.
  - Budgets, usage recording, refusal and truncation handling, and org customization are applied for you.
  - `tier: "bulk"` selects Haiku for high-volume per-item work.
- Never pass `temperature`. Never call the SDK directly. The legacy `callSonnet`/`callOpus` helpers have been removed.
- Third-party content goes into prompts only through `untrusted(source, text)` (`src/server/ai/untrusted.ts`), and the system prompt must include `UNTRUSTED_DATA_POLICY`.
- **Model output is untrusted.** It never chooses IDs, URLs, recipients or credentials; it is validated and escaped per sink.
- Bound prompt sizes. Map-reduce or batch over large inputs instead of concatenating everything, and never truncate silently: record what was skipped.
- Embeddings: `embedTexts(texts, ctx)` / `embedText`. Write vectors with raw SQL and `${toVectorLiteral(v)}::vector`. Store `embeddingModel` and only compare vectors from the same model.

### Storage and outbound HTTP
- Object keys come from `projectObjectKey(projectId, kind, id, filename)`. Read only keys that pass `keyBelongsToProject`. Downloads use `getStorage().presignGet(key)`.
- Uploads: `getStorage().createUpload({ key, contentType, maxBytes })` (presigned POST). After upload, `head()` the key and validate it with `resolveUploadMime` (magic bytes).
- **Every** server-side fetch to a user-influenced destination uses `safeFetch` (`src/lib/safe-fetch.ts`). Validate provider host fragments (subdomains, instance URLs) against strict patterns before building a URL.

### Secrets
- Integration credentials: `encryptCredentials` / `getOrgIntegrationCredentials` (`src/server/integrations/credentials.ts`).
- Other secrets (webhook signing secrets): `encryptString` / `decryptString` (`src/lib/crypto.ts`).
- Never return secrets to clients. Show a newly created secret once, then only a masked form.

### API design
- Validate every input with zod. Cap every string (`.max()`), array and number; paginate every list (`limit` max 100 plus `cursor`). Never return unbounded text blobs in lists.
- Rate limits: `llmProcedure` for anything that triggers LLM work, `outboundProcedure` for emails, invites and webhook tests.
- Errors: throw `TRPCError` with user-presentable messages. Internal errors are masked by the error formatter.

### Frontend
- tRPC hooks from `@/lib/trpc`. The provider sends the active org header and refetches everything on an org switch.
- Every data view handles loading, empty and error states (`isError`). Mutations surface errors through the global toast; use `toast.success` for confirmations.
- Poll with `refetchInterval` only while a row is non-terminal, and stop on READY/FAILED. Invalidate the affected list queries on success.
- Accessibility: labels associated with inputs (`<Label htmlFor>`), icon-only buttons have `aria-label`, dialogs use the Radix `Dialog`, links styled as buttons use `<Button asChild><Link/></Button>`.
- No mock or sample data in components. Every number shown comes from the API.

### Tests
- Vitest against real Postgres and Redis (`tests/setup.ts`), with fakes for the LLM (`scriptLLM(feature, fn)`), embeddings, storage and job capture (`jobsFor(queue)`). Factories are in `tests/helpers/factories.ts`, and the authenticated tRPC caller is `callerFor(user, orgId?)` in `tests/helpers/caller.ts`.
- Every feature has authorization tests: an outsider gets NOT_FOUND, a VIEWER is blocked from writes, and cross-org foreign IDs are rejected. It also has a worker test that runs the handler directly and asserts the row reaches READY, then FAILED on error, with no duplicates on re-run.

## Cross-feature contracts

These are the interfaces features depend on from each other. Keep them stable.

| Provider | Contract |
|---|---|
| projects | `project.list({ limit?, cursor? }) → { items: [{ id, name, description, createdAt, updatedAt, counts: { documents, syntheses, recommendations } }], nextCursor: string \| null }` |
| organizations | `organization.listMine() → [{ id, name, slug, isPersonal, role, plan }]` |
| collaboration UI | `<NotificationBell />` (no props) in `src/components/collaboration/notification-bell.tsx` |
| coach UI | `<CoachBell projectId />` in `src/components/coach/coach-bell.tsx` |
| documents | `createDocumentFromText(...)` in `src/server/documents/ingest.ts`: every non-upload source ingests through it |
| synthesis | `getLatestThemes(projectId)` in `src/server/synthesis/queries.ts` |
| notifications | `notify({ userIds, type, title, message, resourceType, resourceId, href, dedupeKey })` in `src/server/notifications/notify.ts` |
| integrations | `getOrgIntegrationCredentials(orgId, provider)` in `src/server/integrations/credentials.ts`; outbound actions `createJiraIssue` / `createLinearIssue` / `postSlackMessage(orgId, ...)` in `src/server/integrations/outbound.ts` |
| UI states | `LoadingState`, `EmptyState`, `ErrorState`, `QueryState` in `src/components/ui/states.tsx` |
| jobs | `job.get({ id })` for any `JobRun` |

Events emitted by each feature are listed in `src/server/events/catalog.ts`; feature code must emit the events its domain owns (for example, documents emit `document.ready`/`document.failed`).

## Database

- Schema changes: edit `prisma/schema.prisma`, then `npx prisma migrate dev --create-only --name <change>`. **Delete any generated `DROP INDEX "*_embedding_hnsw_idx"` lines**: Prisma can't express pgvector HNSW indexes and always proposes dropping them. Apply the migration with `npx prisma migrate dev`.
- CI runs `scripts/check-migration-drift.sh`.
- Indexes Prisma can't express (HNSW, full-text GIN) live in migration SQL. Full-text queries must use exactly `to_tsvector('english', content)`.
