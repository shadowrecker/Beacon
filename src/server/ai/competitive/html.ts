/**
 * Small, dependency-free HTML → readable text extractor.
 *
 * A single-pass tokenizer (comments, doctype, CDATA, raw-text elements, quoted
 * attributes) feeding a stack-based walker. It is not a full HTML5 tree builder,
 * but it is robust to the things that break regex "parsers": `>` inside quoted
 * attributes, `<script>` bodies containing markup, unclosed tags, comments, and
 * entities.
 *
 * Used for competitor pages (readable text split into heading sections, with
 * navigation, scripts, styles, forms and chrome removed) and for HTML fragments
 * from integrations (ticket bodies, notes).
 */

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is never text (raw text: content is not parsed as markup). */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes", "template"]);

/** Subtrees dropped from page extraction (chrome, not content). */
const PAGE_SKIP = new Set([
  "script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "video", "audio",
  "nav", "header", "footer", "aside", "form", "button", "select", "dialog", "menu", "textarea",
]);

/** Subtrees dropped from fragment extraction (e.g. ticket bodies). */
const FRAGMENT_SKIP = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "head", "title"]);

const SKIP_ROLES = new Set(["navigation", "banner", "contentinfo", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar"]);

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "li", "main", "nav", "ol", "p",
  "pre", "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "ul", "br",
]);

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", sbquo: "‚",
  bdquo: "„", laquo: "«", raquo: "»", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  deg: "°", plusmn: "±", times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢",
  sect: "§", para: "¶", dagger: "†", Dagger: "‡", larr: "←", rarr: "→", uarr: "↑", darr: "↓",
  check: "✓", hearts: "♥", star: "☆", frac12: "½", frac14: "¼", frac34: "¾", shy: "",
  zwj: "", zwnj: "", lrm: "", rlm: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "start"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "end"; name: string };

function parseAttributes(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(src)) && count++ < 64) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Find the end of a tag starting at `i` (index of '<'), honoring quoted attribute values. */
function findTagEnd(html: string, i: number): number {
  let quote: string | null = null;
  for (let j = i + 1; j < html.length; j++) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return j;
    }
  }
  return -1;
}

export function* tokenize(html: string): Generator<Token> {
  let i = 0;
  const n = html.length;
  let lower: string | null = null;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      yield { kind: "text", text: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: "text", text: html.slice(i, lt) };

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      yield { kind: "text", text: html.slice(lt + 9, end === -1 ? n : end) };
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const isEnd = html[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (isEnd ? 2 : 1), lt + (isEnd ? 2 : 1) + 64));
    if (!nameMatch) {
      // A stray '<' is text.
      yield { kind: "text", text: "<" };
      i = lt + 1;
      continue;
    }
    const end = findTagEnd(html, lt);
    if (end === -1) {
      i = n;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    if (isEnd) {
      yield { kind: "end", name };
      i = end + 1;
      continue;
    }
    const inner = html.slice(lt + 1 + nameMatch[0].length, end);
    const selfClosing = inner.trimEnd().endsWith("/");
    yield { kind: "start", name, attrs: parseAttributes(inner), selfClosing };
    i = end + 1;

    if (RAW_TEXT.has(name) && !selfClosing) {
      lower ??= html.toLowerCase();
      const close = lower.indexOf(`</${name}`, i);
      const stop = close === -1 ? n : close;
      yield { kind: "text", text: html.slice(i, stop) };
      if (close === -1) return;
      const closeEnd = html.indexOf(">", close);
      yield { kind: "end", name };
      i = closeEnd === -1 ? n : closeEnd + 1;
    }
  }
}

export interface Section {
  heading: string | null;
  level: number;
  text: string;
}

export interface Readable {
  title: string | null;
  description: string | null;
  /** Readable text with paragraph breaks. */
  text: string;
  /** Content split at h1–h3 headings (changelog entries, blog posts). */
  sections: Section[];
}

function normalizeBlock(text: string): string {
  return text
    .replace(/[ \t\f\v\u00a0\u200b]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface ExtractOptions {
  mode: "page" | "fragment";
  /** Stop collecting after this many characters of text. */
  maxChars?: number;
}

/** Extract readable text (and heading sections) from an HTML document or fragment. */
export function extractReadable(html: string, opts: ExtractOptions = { mode: "page" }): Readable {
  const skipSet = opts.mode === "page" ? PAGE_SKIP : FRAGMENT_SKIP;
  const maxChars = opts.maxChars ?? 500_000;

  let title: string | null = null;
  let description: string | null = null;

  // Separate buffers for the whole body and for <main>/<article> content.
  const all: string[] = [];
  const main: string[] = [];
  let mainDepth = 0;
  let total = 0;

  const skipStack: string[] = [];
  let inTitle = false;
  const listStack: Array<{ ordered: boolean; n: number }> = [];

  // Sections
  const sections: Array<{ heading: string | null; level: number; parts: string[] }> = [{ heading: null, level: 0, parts: [] }];
  let headingCapture: { level: number; parts: string[] } | null = null;

  const push = (s: string) => {
    if (total > maxChars) return;
    total += s.length;
    if (headingCapture) {
      headingCapture.parts.push(s);
      return;
    }
    all.push(s);
    if (mainDepth > 0) main.push(s);
    sections[sections.length - 1].parts.push(s);
  };

  for (const tok of tokenize(html)) {
    if (tok.kind === "text") {
      if (inTitle) {
        if (title === null) title = normalizeBlock(decodeEntities(tok.text)).slice(0, 300) || null;
        continue;
      }
      if (skipStack.length > 0) continue;
      push(decodeEntities(tok.text).replace(/[\r\n\t]+/g, " "));
      continue;
    }

    if (tok.kind === "start") {
      const { name, attrs } = tok;
      if (name === "title" && opts.mode === "page" && skipStack.length === 0) {
        inTitle = !tok.selfClosing;
        continue;
      }
      if (name === "meta") {
        const key = (attrs.name ?? attrs.property ?? "").toLowerCase();
        if ((key === "description" || key === "og:description") && attrs.content && !description) {
          description = normalizeBlock(attrs.content).slice(0, 500);
        }
        continue;
      }
      const role = (attrs.role ?? "").toLowerCase();
      const hidden =
        "hidden" in attrs || (attrs["aria-hidden"] ?? "").toLowerCase() === "true" || (opts.mode === "page" && SKIP_ROLES.has(role));
      if (skipStack.length > 0 || skipSet.has(name) || hidden) {
        if (!VOID.has(name) && !tok.selfClosing) skipStack.push(name);
        continue;
      }
      if (name === "main" || name === "article" || role === "main") {
        if (!tok.selfClosing) mainDepth++;
      }
      const level = HEADING_LEVEL[name];
      if (level && level <= 3 && opts.mode === "page") {
        headingCapture = { level, parts: [] };
        continue;
      }
      if (name === "ul" || name === "ol") listStack.push({ ordered: name === "ol", n: 0 });
      if (name === "li") {
        const list = listStack[listStack.length - 1];
        if (list) list.n++;
        push(list?.ordered ? `\n${list.n}. ` : "\n- ");
        continue;
      }
      if (name === "td" || name === "th") {
        push(" | ");
        continue;
      }
      if (name === "img" && attrs.alt && opts.mode === "fragment") {
        push(` [image: ${attrs.alt.slice(0, 100)}] `);
        continue;
      }
      if (BLOCK.has(name)) push(name === "br" ? "\n" : "\n\n");
      continue;
    }

    // end tag
    const { name } = tok;
    if (name === "title" && inTitle) {
      inTitle = false;
      continue;
    }
    if (skipStack.length > 0) {
      // Pop to the matching open skip element (tolerates unclosed children).
      const idx = skipStack.lastIndexOf(name);
      if (idx !== -1) skipStack.length = idx;
      continue;
    }
    if ((name === "main" || name === "article") && mainDepth > 0) mainDepth--;
    const level = HEADING_LEVEL[name];
    if (level && level <= 3 && headingCapture && opts.mode === "page") {
      const heading = normalizeBlock(headingCapture.parts.join("")).replace(/\n+/g, " ").slice(0, 300);
      const capturedLevel = headingCapture.level;
      headingCapture = null;
      if (heading) {
        all.push(`\n\n${heading}\n\n`);
        if (mainDepth > 0) main.push(`\n\n${heading}\n\n`);
        sections.push({ heading, level: capturedLevel, parts: [] });
      }
      continue;
    }
    if (name === "ul" || name === "ol") listStack.pop();
    if (BLOCK.has(name)) push("\n\n");
  }

  const allText = normalizeBlock(all.join(""));
  const mainText = normalizeBlock(main.join(""));
  // Prefer <main>/<article> when it carries most of the content.
  const text = mainText.length >= 200 && mainText.length >= allText.length * 0.3 ? mainText : allText;

  const outSections: Section[] = sections
    .map((s) => ({ heading: s.heading, level: s.level, text: normalizeBlock(s.parts.join("")) }))
    .filter((s) => s.text.length > 0 || s.heading);

  return { title, description, text, sections: outSections };
}

/** Plain text of an HTML fragment (ticket bodies, notes, comments). */
export function htmlToText(html: string, maxChars = 200_000): string {
  if (!/[<&]/.test(html)) return normalizeBlock(html).slice(0, maxChars);
  return extractReadable(html, { mode: "fragment", maxChars }).text.slice(0, maxChars);
}
