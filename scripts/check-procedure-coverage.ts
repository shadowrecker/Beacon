/**
 * Completeness check: every tRPC procedure must have a caller in the UI
 * (src/app or src/components), or be listed in scripts/procedure-allowlist.json
 * with a reason (e.g. used only by server code, or API-only by design).
 *
 *   npx tsx scripts/check-procedure-coverage.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(p);
  }
  return out;
}

async function main() {
  // Minimal env so modules that read config lazily can be imported.
  process.env.DATABASE_URL ??= "postgresql://localhost/unused";
  process.env.REDIS_URL ??= "redis://localhost:6379";
  const { appRouter } = await import("../src/server/root");
  const procedures = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures).sort();

  const allowlist = JSON.parse(readFileSync(path.join(ROOT, "scripts/procedure-allowlist.json"), "utf8")) as Record<string, string>;
  const source = [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))]
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const uncovered: string[] = [];
  for (const proc of procedures) {
    const [routerName, ...rest] = proc.split(".");
    const name = rest.join(".");
    const re = new RegExp(`\\btrpc\\.${routerName}\\.${name.replace(/\./g, "\\.")}\\.(use\\w+|fetch|prefetch)\\b`);
    if (!re.test(source) && !allowlist[proc]) uncovered.push(proc);
  }

  const staleAllowlist = Object.keys(allowlist).filter((p) => !procedures.includes(p));

  console.log(`procedures: ${procedures.length}, allowlisted: ${Object.keys(allowlist).length}, uncovered: ${uncovered.length}`);
  if (staleAllowlist.length) console.log(`allowlist entries for procedures that no longer exist:\n  ${staleAllowlist.join("\n  ")}`);
  if (uncovered.length) {
    console.error(`Procedures with no UI caller (add UI or allowlist with a reason):\n  ${uncovered.join("\n  ")}`);
    process.exit(1);
  }
  if (staleAllowlist.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
