// k6: 20 concurrent Q&A requests. Threshold: p95 < 10 s. Spends real LLM tokens.
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 20,
  duration: "3m",
  thresholds: {
    http_req_failed: ["rate<0.02"],
    "http_req_duration{kind:ask}": ["p(95)<10000"],
  },
};

const QUESTIONS = [
  "What are the most common complaints about onboarding?",
  "Which features do enterprise customers request most?",
  "What do users say about pricing?",
  "Why do customers churn?",
  "What integrations are requested most often?",
];

export default function () {
  const question = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  const res = http.post(
    `${__ENV.BASE_URL}/api/trpc/query.ask?batch=1`,
    JSON.stringify({ 0: { json: { projectId: __ENV.PROJECT_ID, question } } }),
    { headers: { cookie: `__session=${__ENV.SESSION_TOKEN}`, "content-type": "application/json" }, tags: { kind: "ask" }, timeout: "60s" }
  );
  check(res, { "status 200 or 429": (r) => r.status === 200 || r.status === 429 });
  sleep(2);
}
