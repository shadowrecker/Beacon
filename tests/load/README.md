# Load tests (k6)

Each script states its target below. Run against **staging**, never production.

```bash
# Authenticated tRPC traffic needs a Clerk session token for a staging test user:
export BASE_URL=https://staging.example.com
export SESSION_TOKEN=...        # __session cookie value for a staging test user
export PROJECT_ID=...           # a seeded project in that user's org
export API_KEY=bk_live_...      # a staging API key with projects:read, documents:write

k6 run tests/load/browse.js     # 50 VUs browsing: p95 < 500 ms for list endpoints
k6 run tests/load/rag.js        # 20 concurrent Q&A: p95 < 10 s
k6 run tests/load/ingest.js     # burst of 200 text documents via the REST API; queue must drain
```

Pass criteria: the thresholds in each script, plus, after `ingest.js`, zero documents left in PENDING or PROCESSING once the queue has drained, and database connections staying under the pool limit throughout.
