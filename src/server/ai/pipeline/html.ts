/**
 * Readability-style text extraction from HTML for URL imports (no DOM, no
 * dependencies). Scripts, styles, embedded objects and page chrome (nav,
 * header, footer, aside, forms) are dropped; the main content (<article> or
 * <main> when present) is preferred; block elements become line breaks and
 * entities are decoded. Output is plain text with paragraphs separated by
 * blank lines.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  agrave: "à",
  ouml: "ö",
  uuml: "ü",
  auml: "ä",
  ccedil: "ç",
  ntilde: "ñ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

/** Title from og:title, twitter:title or <title>. */
export function extractTitle(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (key === "og:title" || key === "twitter:title") {
      const content = attr(tag, "content");
      if (content && content.trim()) return decodeEntities(content).replace(/\s+/g, " ").trim().slice(0, 300);
    }
  }
  const t = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = t ? decodeEntities(t[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() : "";
  return title ? title.slice(0, 300) : null;
}

const DROP_WITH_CONTENT = ["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed", "canvas", "video", "audio", "select", "head"];
const CHROME = ["nav", "header", "footer", "aside", "form", "dialog", "menu"];
const BLOCK = /<\/?(p|div|section|article|main|br|hr|li|ul|ol|dl|dt|dd|tr|table|thead|tbody|tfoot|blockquote|pre|figure|figcaption|h[1-6]|address|details|summary)\b[^>]*>/gi;

function stripElements(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  return out;
}

/** Slice from the first opening tag to the last closing tag of `tag`, if present. */
function region(html: string, tag: string): string | null {
  const open = html.search(new RegExp(`<${tag}\\b`, "i"));
  if (open < 0) return null;
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  let last = -1;
  for (let m = closeRe.exec(html); m; m = closeRe.exec(html)) last = m.index + m[0].length;
  return last > open ? html.slice(open, last) : html.slice(open);
}

function toText(fragment: string): string {
  const withBreaks = fragment
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(BLOCK, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .replace(/[ \t\f\v ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(\n- )+\n/g, "\n")
    .trim();
}

export function htmlToText(html: string): string {
  let doc = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
  doc = stripElements(doc, DROP_WITH_CONTENT);
  const body = region(doc, "body") ?? doc;
  const main = region(body, "article") ?? region(body, "main");
  if (main) {
    const text = toText(stripElements(main, CHROME));
    if (text.length >= 200) return text;
  }
  return toText(stripElements(body, CHROME));
}
