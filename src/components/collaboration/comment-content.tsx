"use client";

import { Fragment } from "react";

const TOKEN_RE = /@\[([^\]\n]{1,100})\]\(user:([a-z0-9]{10,40})\)/gi;

/**
 * Render comment text: mention tokens become "@Name" using the member's current
 * name from the server (never the label typed into the token). Text is rendered
 * as React text nodes, so it can't inject markup.
 */
export function CommentContent({ content, mentions }: { content: string; mentions: Array<{ id: string; name: string }> }) {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  const parts: Array<{ text: string; mention?: boolean }> = [];
  let last = 0;
  for (const m of content.matchAll(TOKEN_RE)) {
    const index = m.index ?? 0;
    if (index > last) parts.push({ text: content.slice(last, index) });
    const name = names.get(m[2]);
    parts.push(name ? { text: `@${name}`, mention: true } : { text: `@${m[1]}` });
    last = index + m[0].length;
  }
  if (last < content.length) parts.push({ text: content.slice(last) });

  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {parts.map((p, i) =>
        p.mention ? (
          <span key={i} className="rounded bg-primary/10 px-0.5 font-medium text-primary">
            {p.text}
          </span>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </p>
  );
}

/** Convert stored tokens to the editable form ("@Name") plus the mentions they carry. */
export function tokensToEditable(content: string, mentions: Array<{ id: string; name: string }>) {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  const picked: Array<{ id: string; name: string }> = [];
  const text = content.replace(TOKEN_RE, (_all, label: string, id: string) => {
    const name = names.get(id) ?? label;
    if (!picked.some((p) => p.id === id)) picked.push({ id, name });
    return `@${name}`;
  });
  return { text, mentions: picked };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn "@Name" occurrences of picked members back into mention tokens for submission. */
export function editableToTokens(text: string, mentions: Array<{ id: string; name: string }>): string {
  let out = text;
  for (const m of [...mentions].sort((a, b) => b.name.length - a.name.length)) {
    const label = m.name.replace(/[\]\n]/g, " ").slice(0, 100);
    out = out.replace(new RegExp(`@${escapeRegExp(m.name)}(?![\\w])`, "g"), `@[${label}](user:${m.id})`);
  }
  return out;
}
