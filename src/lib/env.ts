/**
 * Server environment configuration.
 *
 * Validation is lazy and centralized: nothing throws at import time (so `next build`
 * and tests can import any module without secrets), and `assertServerEnv()` is
 * called once at process start (instrumentation.ts for the web server, the worker
 * entry point for workers) so a misconfigured deploy fails fast at boot instead of
 * inside a request.
 */
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Core infrastructure
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  APP_URL: z.string().url().default("http://localhost:3000"),

  // Auth (Clerk)
  CLERK_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  // Server-side admin path (plan changes, support tooling). Unset disables it.
  ADMIN_API_TOKEN: z.string().min(32).optional(),

  // LLM + embeddings
  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL_DEFAULT: z.string().default("claude-opus-5-5"),
  MODEL_BULK: z.string().default("claude-haiku-5-5"),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-large"),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default("nova-3"),

  // Object storage
  STORAGE_DRIVER: z.enum(["s3", "local"]).default("s3"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  LOCAL_STORAGE_DIR: z.string().default(".devdata/storage"),
  STORAGE_SIGNING_SECRET: z.string().optional(),

  // Encryption of secrets at rest: JSON map of key version -> base64 32-byte key,
  // e.g. {"1":"base64..."}; CREDENTIALS_KEY_VERSION selects the key for new writes.
  CREDENTIALS_ENCRYPTION_KEYS: z.string().optional(),
  CREDENTIALS_KEY_VERSION: z.coerce.number().int().positive().default(1),

  // Email
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Beacon <notifications@localhost>"),

  // Observability
  SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().default("https://us.i.posthog.com"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/** Parsed server env. Throws a ConfigError listing every invalid/missing var. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`Invalid server environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the cache (tests mutate process.env between cases). */
export function resetServerEnvCache(): void {
  cached = null;
}

/**
 * Fail-fast boot validation. Beyond the schema, enforces production-only
 * requirements (things that are optional locally but mandatory in prod).
 */
export function assertServerEnv(): ServerEnv {
  const env = getServerEnv();
  if (env.NODE_ENV === "production") {
    const missing: string[] = [];
    const need = (key: keyof ServerEnv) => {
      if (!env[key]) missing.push(String(key));
    };
    need("CLERK_WEBHOOK_SECRET");
    need("ANTHROPIC_API_KEY");
    need("OPENAI_API_KEY");
    need("CREDENTIALS_ENCRYPTION_KEYS");
    if (env.STORAGE_DRIVER !== "s3") {
      missing.push("STORAGE_DRIVER=s3 (local driver is not allowed in production)");
    }
    need("S3_BUCKET");
    if (missing.length > 0) {
      throw new ConfigError(
        `Missing required production configuration:\n${missing.map((m) => `  - ${m}`).join("\n")}`
      );
    }
  }
  return env;
}

/** Read one var that a feature needs, with a clear error if it's absent. */
export function requireEnv<K extends keyof ServerEnv>(key: K): NonNullable<ServerEnv[K]> {
  const value = getServerEnv()[key];
  if (value === undefined || value === null || value === "") {
    throw new ConfigError(`${String(key)} is not configured`);
  }
  return value as NonNullable<ServerEnv[K]>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
