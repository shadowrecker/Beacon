# Beacon

AI product-decision intelligence. Teams bring in customer evidence (uploaded documents, call recordings, support tickets and CRM records synced from 12 integrations, voice notes). Beacon turns it into cited themes, recommendations, roadmap gap analyses, sentiment and churn-risk assessments, a knowledge graph, presentations and engineering handoffs.

## Stack

- **Web:** Next.js 15 (App Router), React 19, Tailwind with shadcn/ui primitives, tRPC 11 with React Query, Clerk 6 auth
- **Workers:** BullMQ on Redis. One worker per queue, plus a maintenance worker for stuck-job sweeps, retention and schedulers.
- **Data:** Postgres with pgvector (HNSW indexes) via Prisma 6. Object storage on S3, R2 or MinIO.
- **AI:** Anthropic Claude (`claude-opus-5-5`, plus `claude-haiku-5-5` for bulk work) with structured outputs; OpenAI embeddings; Deepgram transcription
- **Ops:** Sentry, PostHog, structured JSON logs, Docker images for web and worker, GitHub Actions CI

## Documentation

| Document | What it covers |
|---|---|
| [SETUP.md](SETUP.md) | Run Beacon locally |
| [docs/ENGINEERING.md](docs/ENGINEERING.md) | Architecture, conventions every feature follows, cross-feature contracts |
| [docs/RUNBOOKS.md](docs/RUNBOOKS.md) | Operating Beacon in production: deploys, incidents, key rotation, backups |

## Common commands

```bash
npm run dev                  # web
npm run worker               # background workers
npm test                     # unit + integration tests (Postgres + Redis)
npm run type-check && npm run lint
npm run build                # production web build (needs no secrets)
npm run worker:build         # worker bundle (dist/workers/index.js)
npm run db:migrate:deploy    # apply migrations
```

## Deploying

Build both images (`Dockerfile`, `Dockerfile.worker`). Run `prisma migrate deploy` as a release step, then roll the worker and the web tier. `docker-compose.yml` is a complete production-like reference stack. Health endpoints:

- web: `/api/health/live` (liveness) and `/api/health` (readiness: DB and Redis)
- worker: `:9464/live` and `:9464/ready`

Required production configuration is enforced at boot by `src/lib/env.ts`; see `.env.example`.
