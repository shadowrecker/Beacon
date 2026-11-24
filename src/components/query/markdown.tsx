/**
 * Minimal, safe Markdown rendering for model answers: paragraphs, headings,
 * bullet/numbered lists, **bold**, *italic* and `code`. Everything is rendered
 * as React text nodes (no HTML injection); links are not rendered.
 */
import type { ReactNode } from "react";

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) out.push(<code key={key} className="rounded bg-gray-100 px-1 py-0.5 text-[0.85em] dark:bg-gray-800">{token.slice(1, -1)}</code>);
    else out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((block, b) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (lines.length === 0) return null;
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={b} className="list-disc space-y-1 pl-5">
              {lines.map((l, i) => (
                <li key={i}>{inline(l.replace(/^\s*[-*•]\s+/, ""), `${b}-${i}`)}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={b} className="list-decimal space-y-1 pl-5">
              {lines.map((l, i) => (
                <li key={i}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""), `${b}-${i}`)}</li>
              ))}
            </ol>
          );
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(lines[0]);
        if (heading && lines.length === 1) {
          return (
            <p key={b} className="font-semibold">
              {inline(heading[1], `${b}`)}
            </p>
          );
        }
        return (
          <p key={b}>
            {lines.map((l, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {inline(l.replace(/^#{1,6}\s+/, ""), `${b}-${i}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
