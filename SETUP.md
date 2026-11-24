# Local development setup

## Prerequisites

- Node.js 22 or newer
- Postgres 16+ with the pgvector extension, and Redis 7+, run in one of two ways:
  - **Docker:** `make services-up` starts Postgres on `127.0.0.1:5433`, Redis on `127.0.0.1:6380` and MinIO, from `docker-compose.dev.yml`.
  - **Homebrew (no Docker):**
    ```bash
    brew install postgresql@18 pgvector redis
    PG=/opt/homebrew/opt/postgresql@18/bin
    $PG/initdb -D .devdata/pg -U beacon --auth=trust -E UTF8
    $PG/pg_ctl -D .devdata/pg -o "-p 5433" -l .devdata/pg.log start
    $PG/psql -h localhost -p 5433 -U beacon -d postgres \
      -c "CREATE DATABASE beacon;" -c "CREATE DATABASE beacon_test;" -c "CREATE DATABASE beacon_shadow;" \
      -c "ALTER DATABASE beacon SET timezone TO 'UTC';" -c "ALTER DATABASE beacon_test SET timezone TO 'UTC';"
    redis-server --port 6380 --daemonize yes --dir .devdata --maxmemory-policy noeviction
    ```
    Databases must run in UTC: Prisma stores UTC timestamps without a time zone.

## Configure

```bash
npm install
cp .env.example .env.local   # then edit
```

For local development set:

| Variable | Local value |
|---|---|
| `DATABASE_URL` | `postgresql://beacon@localhost:5433/beacon` (also put this one line in `.env`, which the Prisma CLI reads) |
| `REDIS_URL` | `redis://localhost:6380` |
| `STORAGE_DRIVER` | `local`, which stores files under `.devdata/storage` and serves signed URLs from `/api/storage/local`; or use MinIO with `STORAGE_DRIVER=s3` |
| `NODE_ENV` | `development` |
| Clerk | Create a development instance at dashboard.clerk.com. Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. Add a webhook endpoint for `/api/webhooks/clerk` (events `user.created`, `user.updated`, `user.deleted`) and set `CLERK_WEBHOOK_SECRET`; use a tunnel such as ngrok so Clerk can reach localhost. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Required for any AI feature (synthesis, recommendations, Q&A, embeddings). |
| `DEEPGRAM_API_KEY` | Required only for audio/video transcription. |

`CREDENTIALS_ENCRYPTION_KEYS` falls back to a fixed development key when `NODE_ENV` isn't `production`. Production requires a real key.

## Run

```bash
npm run db:migrate:deploy   # apply migrations
npm run db:seed             # optional demo data (refuses to run in production)
npm run dev                 # http://localhost:3000
npm run worker              # in a second terminal: background jobs
```

## Test

```bash
npm test                    # unit + integration (uses beacon_test; TEST_DATABASE_URL / TEST_REDIS_URL override)
npm run test:coverage       # with the coverage gate used in CI
./scripts/check-migration-drift.sh   # needs SHADOW_DATABASE_URL
npx tsx scripts/check-procedure-coverage.ts
./scripts/check-no-mock-data.sh
```

End-to-end tests (`npm run test:e2e`) need Playwright browsers (`npx playwright install chromium`) and a Clerk development instance.
