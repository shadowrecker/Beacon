/**
 * Dependency audit gate: fails on any high/critical advisory in production
 * dependencies that is not explicitly accepted in scripts/audit-allowlist.json,
 * and on accepted entries whose review date has passed.
 *
 *   npx tsx scripts/check-audit.ts
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

interface Via {
  title?: string;
  severity?: string;
  url?: string;
}
interface Vuln {
  severity: string;
  via: Array<Via | string>;
}

const allowlist = JSON.parse(readFileSync(path.resolve(__dirname, "audit-allowlist.json"), "utf8")) as {
  advisories: Record<string, { package: string; match: string; reason: string; reviewBy: string }>;
};

let raw: string;
try {
  raw = execSync("npm audit --omit=dev --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (err) {
  // npm audit exits non-zero when vulnerabilities exist; the JSON is still on stdout.
  raw = (err as { stdout?: string }).stdout ?? "";
}
const report = JSON.parse(raw) as { vulnerabilities?: Record<string, Vuln> };

const today = new Date().toISOString().slice(0, 10);
const failures: string[] = [];
const accepted: string[] = [];

for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via === "string") continue; // a dependency chain; the leaf is reported separately
    const sev = via.severity ?? v.severity;
    if (sev !== "high" && sev !== "critical") continue;
    const entry = Object.values(allowlist.advisories).find((a) => a.package === pkg && (via.title ?? "").includes(a.match));
    if (!entry) failures.push(`${sev.toUpperCase()} ${pkg}: ${via.title} ${via.url ?? ""}`);
    else if (entry.reviewBy < today) failures.push(`EXPIRED ACCEPTANCE ${pkg}: "${via.title}" (review by ${entry.reviewBy})`);
    else accepted.push(`${pkg}: ${via.title}`);
  }
}

if (accepted.length) console.log(`Accepted (see audit-allowlist.json):\n  ${[...new Set(accepted)].join("\n  ")}`);
if (failures.length) {
  console.error(`\nUnaccepted high/critical advisories:\n  ${[...new Set(failures)].join("\n  ")}`);
  process.exit(1);
}
console.log("\nNo unaccepted high/critical advisories in production dependencies.");
