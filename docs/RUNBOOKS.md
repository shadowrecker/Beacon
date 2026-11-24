# Operations runbooks

Each runbook says how to recognize the situation, what to check, and how to resolve it. Signals refer to the structured JSON logs (`level`, `msg`, `queue`, `jobId`, `requestId`), the health endpoints, and Sentry.

---

## 1. Queue backlog growing

**Signal:** queue depth or oldest-job age keeps rising; users see documents or syntheses stuck in "Processing".

1. Check worker health: `curl :9464/ready` on each worker. If it isn't ready, check Redis and Postgres reachability first (runbooks 4 and 5).
2. Look for failing jobs: search logs for `msg="job failed"` and group by `queue`.
   - `final=false` with the same error repeating usually means an upstream problem (LLM 429/529, Deepgram, integration provider).
3. If failures come from LLM rate limits (429), lower worker concurrency for the affected queue, or temporarily raise the provider rate limit.
4. If it is pure volume, scale worker replicas horizontally. Workers are stateless; BullMQ distributes jobs.
5. Rows that waited too long are moved to FAILED automatically by the maintenance sweep (`sweep-stuck-jobs`, every 10 minutes), and users can retry them. Nothing needs manual cleanup.

## 2. Jobs stuck in PROCESSING

**Signal:** rows in PROCESSING well past their normal duration; `msg="swept stuck jobs"` warnings.

- The sweep fails rows after `STUCK_AFTER_MS` (`src/server/jobs/maintenance.ts`). A steady stream of swept rows means workers are crashing mid-job.
- Check for OOM kills or restarts of the worker container. Search Sentry for the worker release.
- After a deploy: workers drain for `SHUTDOWN_GRACE_MS` (default 120s). If the orchestrator kills them sooner, raise its stop grace period to at least 130s.

## 3. LLM provider outage or sustained 429/529

**Signal:** `llm call` latency spikes; `LLMError` or `status: 429/529` in job failures.

1. Check https://status.anthropic.com (and https://status.openai.com for embeddings).
2. Jobs retry with exponential backoff (3 attempts). During an extended outage, failed rows land in FAILED with a retryable message, and users can press Retry later.
3. Refusals (`reason: "refusal"`) are non-retryable by design. The Opus path already uses server-side fallbacks. If one feature shows a refusal spike, inspect its prompts for content that trips safety classifiers.
4. To shed load, pause the noisiest queue: `getQueue(QUEUE.SENTIMENT).pause()` from a maintenance shell. Resume with `.resume()`.

## 4. Database connection exhaustion

**Signal:** Prisma `P2024` (timed out fetching a connection) or `too many connections`.

- Every process uses one Prisma client (`src/lib/db.ts`). Size the pool with `connection_limit` in `DATABASE_URL`: (web replicas × limit) + (worker replicas × limit) must stay below the database `max_connections`.
- Put PgBouncer or RDS Proxy (transaction mode) in front of Postgres for the web tier.
- Long-running analytical queries: check `pg_stat_activity` for queries over 30s and terminate them if they block.

## 5. Redis unavailable

**Signal:** `redis error` logs; readiness fails; rate-limited (LLM) procedures return TOO_MANY_REQUESTS (they fail closed).

- Queued jobs survive a restart if AOF persistence is on (it is in `docker-compose.yml`; enable it on managed Redis).
- Redis must run with `maxmemory-policy noeviction`. Eviction silently drops BullMQ jobs.
- After recovery, the maintenance sweep re-dispatches any domain events whose fan-out enqueue failed (`redispatchStaleEvents`).

## 6. Restore from backup

1. Restore the managed Postgres snapshot or point-in-time recovery to a **new** instance. Never restore over the primary.
2. Run `npx prisma migrate status` against it to confirm the migration level matches the deployed code.
3. Point a staging deployment at it and verify: sign-in, project list, one Q&A query.
4. Cut traffic over by updating `DATABASE_URL` and rolling web and worker.
5. Object storage is not rolled back by a DB restore. Documents whose storage keys no longer exist show as FAILED on reprocessing.

**Test this quarterly.** An untested restore is not a backup.

## 7. Rotating a leaked or expiring secret

| Secret | Rotation |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `RESEND_API_KEY` | Create a new key in the provider console, update the secret store, roll web and worker, then revoke the old key. |
| `CLERK_SECRET_KEY` / `CLERK_WEBHOOK_SECRET` | Rotate in the Clerk dashboard, update, roll. The webhook verifies with the new secret immediately. |
| `CREDENTIALS_ENCRYPTION_KEYS` (KEK) | Add a new version to the JSON map and set `CREDENTIALS_KEY_VERSION` to it. Roll. New writes use the new key and old ciphertexts still decrypt. Optionally re-encrypt existing rows with a script that reads and re-saves each integration's credentials, then remove the old version. **Never remove a version that still has ciphertexts.** |
| `ADMIN_API_TOKEN`, `OAUTH_STATE_SECRET`, `STORAGE_SIGNING_SECRET` | Replace and roll. In-flight OAuth flows started before rotation will fail and the user retries. |
| S3 access keys | Create new IAM keys, update, roll, then deactivate the old ones. |
| A customer's integration token | The customer disconnects and reconnects the integration. Disconnect revokes provider tokens where the provider supports it. |
| A customer's API key or webhook secret | Revoke in Developer, then create a new one or rotate the webhook secret. |

## 8. Suspected cross-tenant data exposure

1. **Contain.** If a specific endpoint is implicated, disable it (feature flag or route block at the edge) before investigating.
2. **Scope.** Use `requestId`s from logs and Sentry to find the affected requests. Search `ApiUsage` for API-key traffic and `TeamActivity` and `DomainEvent` for in-app actions.
3. Every authorization decision goes through `src/server/auth/access.ts`. Write a failing test that reproduces the exposure (add it to the authorization tests) before fixing.
4. **Notify.** Follow the incident-response policy and contractual and legal notification windows (for example, GDPR's 72 hours).

## 9. A customer requests data deletion or export

- **Deletion:** deleting the user in Clerk triggers `user.deleted`, which erases their data and the projects of orgs where they were the sole member, including stored objects (`deleteUserData` + `deletePrefix`). In-app, Settings → Delete account does the same.
- **Export:** Settings → Export data downloads the user's own data as JSON.
- Org-level deletion (all projects of a team org) is done by an org OWNER from the Team page.

## 10. Deploy and rollback

1. CI green on `main`.
2. Run `prisma migrate deploy` as a release job. Migrations must be backward compatible with the running code (expand, then contract).
3. Deploy workers, which drain in-flight jobs. Then deploy web as a rolling deploy gated on `/api/health`.
4. Smoke check: `/api/health`, sign-in, project list, one Q&A query on a canary project.
5. **Rollback:** redeploy the previous images. Never roll back a migration; ship a forward fix.
