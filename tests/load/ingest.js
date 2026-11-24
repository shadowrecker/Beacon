// k6: burst of 200 text documents through the public REST API, then poll until
// every one reaches READY or FAILED. Verifies the pipeline drains under load.
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    burst: { executor: "shared-iterations", vus: 20, iterations: 200, maxDuration: "5m" },
  },
  thresholds: { http_req_failed: ["rate<0.01"] },
};

const headers = { authorization: `Bearer ${__ENV.API_KEY}`, "content-type": "application/json" };

export default function () {
  const body = {
    title: `Load test interview ${__VU}-${__ITER}`,
    type: "TRANSCRIPT",
    text: `Interviewer: How is onboarding? Customer: Setting up integrations took a week and the docs were unclear. Customer: Pricing for small teams feels high. Iteration ${__ITER}.`,
  };
  const res = http.post(`${__ENV.BASE_URL}/api/v1/projects/${__ENV.PROJECT_ID}/documents`, JSON.stringify(body), { headers });
  check(res, { "created": (r) => r.status === 201 || r.status === 202 });
}

export function teardown() {
  // Poll until nothing is left pending/processing (max 10 minutes).
  for (let i = 0; i < 60; i++) {
    const res = http.get(`${__ENV.BASE_URL}/api/v1/projects/${__ENV.PROJECT_ID}/documents?status=PROCESSING,PENDING&limit=1`, { headers });
    const pending = res.status === 200 ? JSON.parse(res.body).data.length : 1;
    if (pending === 0) return;
    sleep(10);
  }
  throw new Error("Documents still pending after 10 minutes: the queue did not drain");
}
