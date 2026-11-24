/**
 * Next.js instrumentation hook: runs once when the server process starts.
 * Validates configuration (fail fast on a bad deploy) and initializes Sentry.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Skip validation during `next build` (page data collection has no secrets).
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { assertServerEnv } = await import("./lib/env");
      try {
        assertServerEnv();
      } catch (err) {
        // Fail fast: a misconfigured deploy must crash (so the orchestrator
        // marks it unhealthy and keeps the previous version), not serve 500s.
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
      const { registerAICustomization } = await import("./server/ai/custom/hook");
      registerAICustomization();
    }
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs";
