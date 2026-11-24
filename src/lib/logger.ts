/**
 * Minimal structured JSON logger with redaction.
 *
 * One line of JSON per event, so log aggregators can index fields. Sensitive keys
 * are redacted recursively; long strings are truncated so customer content (which
 * is PII) never lands in logs in full.
 */

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "credentials",
  "email",
  "content",
  "question",
  "text",
  "transcript",
  "processedtext",
]);

const MAX_STRING = 500;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length}]` : value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL as Level | undefined) ?? "info";
  return LEVELS[lvl] ?? LEVELS.info;
}

function make(bindings: Record<string, unknown>): Logger {
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
    if (LEVELS[level] < threshold()) return;
    const line = JSON.stringify({
      level,
      time: new Date().toISOString(),
      msg,
      ...(redact(bindings) as object),
      ...(fields ? (redact(fields) as object) : {}),
    });
    if (level === "error" || level === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const logger: Logger = make({ service: process.env.SERVICE_NAME ?? "beacon" });

export { redact as redactForLogging };
