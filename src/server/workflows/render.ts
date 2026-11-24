/**
 * Message templates for workflow actions.
 *
 * Templates are written by workspace members; the values substituted into them
 * come from event payloads, which can carry third-party and model-generated text
 * (theme names, recommendation titles, competitor page titles). Substituted values
 * are therefore escaped for their sink: Slack control characters (&, <, >) are
 * entity-encoded so injected text can never form `<!channel>` mentions or
 * `<url|label>` links, and every value is flattened to a single bounded line.
 */

export type TemplateSink = "slack" | "text";

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,40})\s*\}\}/g;
const MAX_VALUE = 300;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

export function sanitizeValue(value: unknown, sink: TemplateSink): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : String(value);
  s = s.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (s.length > MAX_VALUE) s = `${s.slice(0, MAX_VALUE)}…`;
  if (sink === "slack") s = escapeSlack(s);
  return s;
}

export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Fill `{{name}}` placeholders; unknown names render empty. */
export function renderTemplate(template: string, vars: Record<string, unknown>, sink: TemplateSink): string {
  return template.replace(PLACEHOLDER, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? sanitizeValue(vars[name], sink) : ""
  );
}

/** Top-level scalar payload fields usable as placeholders. */
export function payloadVars(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>).slice(0, 50)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      out[k] = v;
    }
  }
  return out;
}

/** Escape Markdown control characters (Linear renders descriptions as Markdown). */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_[\]()!<>#|~])/g, "\\$1");
}

export function appUrl(path: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path}`;
}
