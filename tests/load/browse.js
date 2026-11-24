// k6: 50 virtual users browsing list views. Threshold: p95 < 500 ms.
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 50,
  duration: "5m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:list}": ["p(95)<500"],
  },
};

const BASE = __ENV.BASE_URL;
const headers = { cookie: `__session=${__ENV.SESSION_TOKEN}` };
const project = __ENV.PROJECT_ID;

function trpcGet(path, input) {
  const qs = encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  return http.get(`${BASE}/api/trpc/${path}?batch=1&input=${qs}`, { headers, tags: { kind: "list" } });
}

export default function () {
  const responses = [
    trpcGet("project.list", { limit: 20 }),
    trpcGet("document.list", { projectId: project, limit: 20 }),
    trpcGet("synthesis.list", { projectId: project, limit: 10 }),
    trpcGet("recommendation.list", { projectId: project, limit: 20 }),
  ];
  for (const r of responses) check(r, { "status 200": (res) => res.status === 200 });
  sleep(1 + Math.random() * 2);
}
