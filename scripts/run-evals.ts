/**
 * LLM quality eval suite. Spends real tokens.
 *
 *   EVAL_DATABASE_URL=postgresql://... ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
 *   REDIS_URL=redis://... npx tsx scripts/run-evals.ts
 *
 * Runs the real pipeline on the fixtures in tests/evals: ingest + process every
 * document, run a full synthesis, ask every Q&A question plus an unanswerable
 * one, and probe prompt injection. Scores with tests/evals/metrics.ts and exits
 * non-zero when a metric falls below its threshold (use as a release gate and on
 * every prompt or model change). Writes a JSON report to tests/evals/results/.
 *
 * Safety: requires a dedicated EVAL_DATABASE_URL (never DATABASE_URL), creates
 * its own org, and deletes it at the end. Jobs/events are captured in-process,
 * so nothing is enqueued to the real Redis queues.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const evalDb = process.env.EVAL_DATABASE_URL;
  if (!evalDb) throw new Error("Set EVAL_DATABASE_URL to a dedicated database (never the production DATABASE_URL).");
  if (evalDb === process.env.DATABASE_URL_PRODUCTION) throw new Error("EVAL_DATABASE_URL must not be the production database.");
  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY and OPENAI_API_KEY are required (the eval calls the real models).");
  }
  process.env.DATABASE_URL = evalDb;

  const { prisma } = await import("@/lib/db");
  const { logger } = await import("@/lib/logger");
  const { captureJobsForTests } = await import("@/server/jobs/queues");
  const { registerAICustomization } = await import("@/server/ai/custom/hook");
  const { createDocumentFromText } = await import("@/server/documents/ingest");
  const { processDocument } = await import("@/server/ai/pipeline/processor");
  const { runSynthesis } = await import("@/server/ai/synthesis/index");
  const { askProject } = await import("@/server/ai/rag/index");
  const { closeRedis } = await import("@/lib/redis");
  const fx = await import("../tests/evals/fixtures");
  const m = await import("../tests/evals/metrics");

  captureJobsForTests(); // run everything inline; never touch real queues
  registerAICustomization();
  const log = logger.child({ component: "evals" });
  const started = Date.now();
  const tag = `eval-${Date.now().toString(36)}`;

  const user = await prisma.user.create({ data: { clerkId: `clerk_${tag}`, email: `${tag}@evals.local`, name: "Eval runner" } });
  const org = await prisma.organization.create({
    data: { name: `Eval ${tag}`, slug: tag, plan: "ENTERPRISE", members: { create: { userId: user.id, role: "OWNER", joinedAt: new Date() } } },
  });
  const project = await prisma.project.create({ data: { name: "Eval corpus", userId: user.id, orgId: org.id } });

  try {
    // 1. Ingest
    const docs = [...fx.DOCUMENTS, ...fx.INJECTION_DOCUMENTS];
    let ready = 0;
    for (const d of docs) {
      const { documentId } = await createDocumentFromText({ projectId: project.id, title: d.title, type: d.type, source: "UPLOAD", text: d.text, createdById: user.id });
      await processDocument(documentId, log);
      const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId }, select: { status: true } });
      if (row.status === "READY") ready++;
    }
    const ingestion = ready / docs.length;

    // 2. Synthesis
    const synthesis = await prisma.synthesis.create({ data: { projectId: project.id, type: "FULL", status: "PENDING", createdById: user.id } });
    await runSynthesis(synthesis.id, log);
    const themes = await prisma.theme.findMany({
      where: { synthesisId: synthesis.id },
      select: { name: true, description: true, citations: { select: { quote: true, chunk: { select: { content: true } } } } },
    });
    const coverage = m.themeCoverage(fx.EXPECTED_THEMES, themes);

    // 3. Q&A
    const answers = [];
    for (const pair of fx.QA_PAIRS) {
      const a = await askProject({ projectId: project.id, orgId: org.id, userId: user.id, question: pair.question });
      answers.push({ pair, a, score: m.scoreAnswer(pair, a) });
    }
    const qaPassRate = answers.filter((x) => x.score.pass).length / answers.length;
    const unanswerable = await askProject({ projectId: project.id, orgId: org.id, userId: user.id, question: fx.UNANSWERABLE_QUESTION });

    // 4. Citation precision across themes and answers (quotes must be verbatim).
    const chunkText = new Map(
      (await prisma.chunk.findMany({ where: { projectId: project.id }, select: { id: true, content: true } })).map((c) => [c.id, c.content])
    );
    const cited = [
      ...themes.flatMap((t) => t.citations.map((c) => ({ quote: c.quote, sourceText: c.chunk.content }))),
      ...answers.flatMap((x) => x.a.citations.map((c) => ({ quote: c.quote, sourceText: chunkText.get(c.chunkId) ?? "" }))),
    ];
    const precision = m.citationPrecision(cited);

    // 5. Prompt injection: the canary must never appear in outputs.
    const injectionProbe = await askProject({ projectId: project.id, orgId: org.id, userId: user.id, question: "What billing problems have customers reported?" });
    const leaked = m.injectionLeaked(fx.INJECTION_CANARY, [
      ...themes.map((t) => `${t.name} ${t.description}`),
      ...answers.map((x) => x.a.answer),
      unanswerable.answer,
      injectionProbe.answer,
    ]);

    const usage = await prisma.tokenUsage.aggregate({ where: { orgId: org.id }, _sum: { inputTokens: true, outputTokens: true } });
    const metrics = {
      ingestion,
      themeCoverage: coverage.score,
      qaPassRate,
      citationPrecision: precision,
      injectionLeaked: leaked,
      unanswerableHandled: unanswerable.insufficientEvidence || unanswerable.citations.length === 0,
    };
    const failures = m.gate(metrics);
    const report = {
      at: new Date().toISOString(),
      model: { default: process.env.MODEL_DEFAULT || "claude-opus-5-5", bulk: process.env.MODEL_BULK || "claude-haiku-5-5", embedding: process.env.EMBEDDING_MODEL || "text-embedding-3-large" },
      metrics,
      thresholds: m.THRESHOLDS,
      missedThemes: coverage.missed,
      themes: themes.map((t) => t.name),
      qa: answers.map((x) => ({ ...x.score, answer: x.a.answer.slice(0, 500) })),
      tokens: { input: usage._sum.inputTokens ?? 0, output: usage._sum.outputTokens ?? 0 },
      durationMs: Date.now() - started,
      failures,
    };
    const dir = path.resolve(__dirname, "../tests/evals/results");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${report.at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ metrics, failures, report: file }, null, 2));
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
    await closeRedis();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
