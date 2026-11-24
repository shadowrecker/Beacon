/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * Safe Markdown for connector setup guides (and any other stored Markdown).
 *
 * The source is parsed into a small typed AST and rendered as React elements,
 * so all text is escaped by React. There is no dangerouslySetInnerHTML: raw HTML
 * in the source (e.g. <script>) is displayed as literal text. Links are kept
 * only for absolute http(s) URLs or same-origin paths; anything else
 * (javascript:, data:, vbscript:, protocol-relative //host, obfuscated schemes)
 * is rendered as plain text.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: MdInline[] }
  | { kind: "em"; children: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: MdInline[] };

export type MdBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; children: MdInline[] }
  | { kind: "paragraph"; children: MdInline[] }
  | { kind: "list"; ordered: boolean; items: MdInline[][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; children: MdInline[] }
  | { kind: "hr" };

const MAX_SOURCE = 50_000;
const MAX_DEPTH = 4;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", sol: "/" };

function decodeForCheck(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITY[body.toLowerCase()] ?? m;
  });
}

/** The href if it is an absolute http(s) URL or a same-origin path; otherwise null. */
export function safeHref(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 2_000) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Whitespace/control characters (including obfuscation like "java\tscript:") are never allowed.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\x20\u007f-\u009f]/.test(trimmed)) return null;
  // Both the raw and the entity-decoded form must pass, so encoded schemes can not sneak through.
  const decoded = decodeForCheck(trimmed);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\x20\u007f-\u009f]/.test(decoded) || decoded.includes("\\")) return null;
  if (trimmed.startsWith("/")) {
    if (trimmed.startsWith("//") || decoded.startsWith("//")) return null;
    return trimmed;
  }
  if (!/^https?:\/\//i.test(trimmed) || !/^https?:\/\//i.test(decoded)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || !u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function pushText(out: MdInline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

/** Find the closing delimiter, skipping escaped characters and code spans. */
function findClose(src: string, from: number, delim: string): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "`" && delim !== "`") {
      const end = src.indexOf("`", i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (src.startsWith(delim, i)) {
      if (delim.length === 1 && (src[i + 1] === delim || (i > from && src[i - 1] === delim))) continue;
      return i;
    }
  }
  return -1;
}

export function parseInline(src: string, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, src);
    return out;
  }
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && /[\\`*_[\]()#+\-.!>]/.test(src[i + 1])) {
      pushText(out, src[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        out.push({ kind: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("**", i) || src.startsWith("__", i)) {
      const delim = src.slice(i, i + 2);
      const end = findClose(src, i + 2, delim);
      if (end > i + 2) {
        out.push({ kind: "strong", children: parseInline(src.slice(i + 2, end), depth + 1) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && src[i + 1] !== c && src[i + 1] !== " " && src[i + 1] !== undefined) {
      const end = findClose(src, i + 1, c);
      if (end > i + 1 && src[end - 1] !== " ") {
        out.push({ kind: "em", children: parseInline(src.slice(i + 1, end), depth + 1) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const close = findClose(src, i + 1, "]");
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        if (end > close + 1) {
          const label = src.slice(i + 1, close);
          const target = src.slice(close + 2, end).trim().split(/\s+/)[0] ?? "";
          const href = safeHref(target);
          const children = parseInline(label, depth + 1);
          if (href) out.push({ kind: "link", href, children });
          else for (const child of children) {
            if (child.kind === "text") pushText(out, child.text);
            else out.push(child);
          }
          i = end + 1;
          continue;
        }
      }
    }
    pushText(out, c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const FENCE = /^\s{0,3}(```|~~~)/;

export function parseMarkdown(src: string): MdBlock[] {
  const lines = String(src ?? "").slice(0, MAX_SOURCE).replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushPara = () => {
    if (para.length) blocks.push({ kind: "paragraph", children: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map((t) => parseInline(t)) });
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ kind: "quote", children: parseInline(quote.join(" ")) });
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !lines[j].trimStart().startsWith(fence[1]); j++) body.push(lines[j]);
      blocks.push({ kind: "code", text: body.join("\n") });
      i = j;
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(4, heading[1].length) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "heading", level, children: parseInline(heading[2]) });
      continue;
    }
    if (HR.test(line)) {
      flushAll();
      blocks.push({ kind: "hr" });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      flushQuote();
      const isOrdered = !!ordered;
      if (list && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push((bullet ?? ordered)![1]);
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      // Continuation of the previous list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderInline(nodes: MdInline[], keyPrefix = "i"): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (n.kind) {
      case "text":
        return <span key={key}>{n.text}</span>;
      case "strong":
        return <strong key={key}>{renderInline(n.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(n.children, key)}</em>;
      case "code":
        return (
          <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {n.text}
          </code>
        );
      case "link": {
        const external = /^https?:\/\//i.test(n.href);
        return (
          <a
            key={key}
            href={n.href}
            className="text-primary underline underline-offset-4"
            {...(external ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})}
          >
            {renderInline(n.children, key)}
            {external && <span className="sr-only"> (opens in a new tab)</span>}
          </a>
        );
      }
    }
  });
}

export function SafeMarkdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed", className)}>
      {blocks.map((b, i) => {
        const key = `b-${i}`;
        switch (b.kind) {
          case "heading": {
            const cls = b.level === 1 ? "text-xl font-semibold" : b.level === 2 ? "text-lg font-semibold" : "text-base font-semibold";
            const content = renderInline(b.children, key);
            if (b.level === 1) return <h2 key={key} className={cls}>{content}</h2>;
            if (b.level === 2) return <h3 key={key} className={cls}>{content}</h3>;
            if (b.level === 3) return <h4 key={key} className={cls}>{content}</h4>;
            return <h5 key={key} className={cls}>{content}</h5>;
          }
          case "paragraph":
            return <p key={key}>{renderInline(b.children, key)}</p>;
          case "list": {
            const items = b.items.map((it, j) => <li key={`${key}-${j}`}>{renderInline(it, `${key}-${j}`)}</li>);
            return b.ordered ? (
              <ol key={key} className="list-decimal space-y-1 pl-5">
                {items}
              </ol>
            ) : (
              <ul key={key} className="list-disc space-y-1 pl-5">
                {items}
              </ul>
            );
          }
          case "code":
            return (
              <pre key={key} className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 pl-3 text-muted-foreground">
                {renderInline(b.children, key)}
              </blockquote>
            );
          case "hr":
            return <hr key={key} className="border-border" />;
        }
      })}
    </div>
  );
}
