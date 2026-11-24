import type { RouterOutputs } from "@/lib/trpc";

export type Brief = NonNullable<RouterOutputs["recommendation"]["getById"]["brief"]>;

/** Render a stored brief as Markdown for export (handoff, docs, tickets). */
export function briefToMarkdown(b: Brief): string {
  const lines: string[] = [`# ${b.title}`, "", `Expected impact: ${b.expectedImpact} · Confidence: ${Math.round(b.confidenceLevel * 100)}%`, ""];
  lines.push("## Problem", "", b.problemStatement, "");
  if (b.impactedSegments.length) lines.push("## Impacted segments", "", ...b.impactedSegments.map((s) => `- ${s}`), "");
  if (b.userStories.length) {
    lines.push("## User stories", "");
    for (const s of b.userStories) {
      lines.push(`- As a ${s.persona}, I want to ${s.action} so that ${s.benefit}.`);
      for (const c of s.acceptanceCriteria) lines.push(`  - [ ] ${c}`);
    }
    lines.push("");
  }
  if (b.requirements.length) {
    lines.push("## Requirements", "");
    for (const r of b.requirements) {
      lines.push(`- **${r.id}** (${r.priority}): ${r.description}`);
      for (const c of r.acceptanceCriteria) lines.push(`  - [ ] ${c}`);
    }
    lines.push("");
  }
  if (b.successMetrics.length) {
    lines.push("## Success metrics", "", ...b.successMetrics.map((m) => `- ${m.metric}: ${m.targetValue} (${m.measuringMethod})`), "");
  }
  if (b.openQuestions.length) lines.push("## Open questions", "", ...b.openQuestions.map((q) => `- ${q}`), "");
  if (b.risks.length) lines.push("## Risks", "", ...b.risks.map((r) => `- ${r}`), "");
  for (const section of b.evidenceAppendix) {
    lines.push(`## Evidence: ${section.category}`, "", ...section.quotes.map((q) => `> ${q.text}\n> — ${q.context}\n`), "");
  }
  lines.push(`_Generated ${new Date(b.generatedAt).toISOString().slice(0, 10)} by Beacon._`);
  return lines.join("\n");
}
