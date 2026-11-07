// What GitHub adds to CommonMark besides tables and strikethrough, which
// markdown-it has: task lists, alerts and heading anchors; and math, as
// pandoc and the chat assistants write it, typeset by KaTeX. And links as
// a PDF can hold them: none to a local file.
import katex from 'katex';
import type { MarkdownIt, StateBlock, StateCore, StateInline, Token } from 'markdown-it';

// What the renderer knows and learns of the document, for the page around it.
export interface DocEnv {
  [key: PropertyKey]: unknown;
  // The document's language, from its front matter.
  lang?: string;
  // Its folder, which relative links resolve against (a file: URL ending
  // in /), and the document itself (a file: URL), when it is a file.
  base?: string;
  document?: string;
  // The text of the first heading of level 1.
  firstH1?: string;
  // Whether a formula needs KaTeX's style sheet and fonts.
  math?: boolean;
  // Whether each open link was kept, for its close.
  links?: boolean[];
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// The text of an inline token, as a reader sees it.
function plainText(inline: Token): string {
  return (inline.children ?? []).map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : '')).join('');
}

// - [ ] and - [x]: a disabled checkbox before the item's text, as GitHub
// renders them; the list loses its bullets.
export function taskLists(md: MarkdownIt): void {
  md.core.ruler.push('task_lists', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i]!;
      if (inline.type !== 'inline' || tokens[i - 1]!.type !== 'paragraph_open' || tokens[i - 2]!.type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const m = first?.type === 'text' ? /^\[([ xX])\](?:[ \t]+|$)/.exec(first.content) : null;
      if (!first || !m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
      inline.children!.unshift(box);
      const item = tokens[i - 2]!;
      item.attrJoin('class', 'task-list-item');
      for (let j = i - 3; j >= 0; j--) {
        const t = tokens[j]!;
        if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === item.level - 1) {
          if (!String(t.attrGet('class') ?? '').includes('contains-task-list')) t.attrJoin('class', 'contains-task-list');
          break;
        }
      }
    }
  });
}

// The titles in the document's language (its front matter's lang), in
// English otherwise, as GitHub writes them.
const ALERT_TITLES: Record<string, Record<string, string>> = {
  en: { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' },
  fr: { note: 'Remarque', tip: 'Astuce', important: 'Important', warning: 'Avertissement', caution: 'Attention' },
  es: { note: 'Nota', tip: 'Consejo', important: 'Importante', warning: 'Advertencia', caution: 'Precaución' },
  de: { note: 'Hinweis', tip: 'Tipp', important: 'Wichtig', warning: 'Warnung', caution: 'Vorsicht' },
  it: { note: 'Nota', tip: 'Suggerimento', important: 'Importante', warning: 'Avviso', caution: 'Attenzione' },
  pt: { note: 'Nota', tip: 'Dica', important: 'Importante', warning: 'Aviso', caution: 'Cuidado' },
};

// > [!NOTE] and its kin, alone on the first line of a quote: a titled box,
// as on GitHub. Before the inline rules, which would read [!NOTE] as text.
export function alerts(md: MarkdownIt): void {
  md.core.ruler.after('block', 'alerts', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 0; i + 2 < tokens.length; i++) {
      const open = tokens[i]!;
      const inline = tokens[i + 2]!;
      if (open.type !== 'blockquote_open' || tokens[i + 1]!.type !== 'paragraph_open' || inline.type !== 'inline') continue;
      const m = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i.exec(inline.content);
      if (!m) continue;
      const kind = m[1]!.toLowerCase();
      inline.content = inline.content.slice(m[0].length);
      // The marker alone in its paragraph: the paragraph goes.
      if (!inline.content.trim()) tokens.splice(i + 1, 3);
      open.tag = 'div';
      open.attrJoin('class', `markdown-alert markdown-alert-${kind}`);
      let depth = 0;
      for (let j = i + 1; j < tokens.length; j++) {
        const t = tokens[j]!;
        if (t.type === 'blockquote_open') depth++;
        else if (t.type === 'blockquote_close' && depth-- === 0) {
          t.tag = 'div';
          break;
        }
      }
      const title = new state.Token('html_block', '', 0);
      const words = ALERT_TITLES[(state.env as DocEnv).lang?.slice(0, 2).toLowerCase() ?? ''] ?? ALERT_TITLES.en!;
      title.content = `<p class="markdown-alert-title">${words[kind]}</p>\n`;
      tokens.splice(i + 1, 0, title);
    }
  });
}

// GitHub's anchors: the heading's text in lower case, without punctuation
// but - and _, spaces as -, and -1, -2… for the same text again. Links to
// #install then work in the PDF.
export function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

export function anchors(md: MarkdownIt): void {
  md.core.ruler.push('anchors', (state: StateCore) => {
    const env = state.env as DocEnv;
    // github-slugger's count: "a", "a", "a-1" give a, a-1, a-1-1.
    const occurrences = new Map<string, number>();
    const tokens = state.tokens;
    for (let i = 0; i + 1 < tokens.length; i++) {
      const open = tokens[i]!;
      if (open.type !== 'heading_open') continue;
      const text = plainText(tokens[i + 1]!);
      if (open.tag === 'h1' && env.firstH1 === undefined && text.trim()) env.firstH1 = text.trim();
      if (open.attrGet('id')) continue;
      const base = slug(text);
      let id = base;
      while (occurrences.has(id)) {
        const n = occurrences.get(base)! + 1;
        occurrences.set(base, n);
        id = `${base}-${n}`;
      }
      occurrences.set(id, 0);
      if (id) open.attrSet('id', id);
    }
  });
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

// $…$ inline: as pandoc reads it, a space neither right after the opening
// $ nor right before the closing one, and no digit right after it, so that
// "$5 and $10" stays text; the formula holds no $ but an escaped one. $$…$$
// in a line is displayed; \(…\) is inline too, as ChatGPT writes it.
function mathInline(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax: max } = state;
  let start: number;
  let end: number;
  let display = false;
  if (src.startsWith('\\(', pos)) {
    start = pos + 2;
    end = src.indexOf('\\)', start);
    if (end === -1 || end + 2 > max) return false;
  } else if (src.startsWith('$$', pos)) {
    start = pos + 2;
    end = src.indexOf('$$', start);
    if (end === -1 || end + 2 > max) return false;
    display = true;
  } else if (src[pos] === '$') {
    start = pos + 1;
    if (isSpace(src[start]) || start >= max || isWord(src[pos - 1])) return false;
    end = start;
    for (;;) {
      end = src.indexOf('$', end);
      if (end === -1 || end >= max) return false;
      let k = end - 1;
      while (src[k] === '\\') k--;
      if ((end - 1 - k) % 2 === 0) break;
      end++;
    }
    if (isSpace(src[end - 1]) || /\d/.test(src[end + 1] ?? '') || isWord(src[end + 1])) return false;
  } else {
    return false;
  }
  const content = src.slice(start, end);
  if (!content.trim()) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.markup = display ? '$$' : '$';
  }
  state.pos = end + (display || src[pos] === '\\' ? 2 : 1);
  return true;
}

// $$ or \[ opening a line, up to the line that ends with $$ or \]: a
// displayed formula, which may interrupt a paragraph. Not across a blank
// line, which TeX does not allow in a formula: an unclosed $$ swallows no
// paragraph. Over several lines, \[ stands alone on its first, as chat
// assistants write it: "\[1\] Smith, 2020." is a reference, as converters
// from HTML escape it.
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const lineAt = (n: number) => state.src.slice(state.bMarks[n]! + state.tShift[n]!, state.eMarks[n]!);
  const first = lineAt(startLine);
  const [open, close] = first.startsWith('$$') ? ['$$', '$$'] : first.startsWith('\\[') ? ['\\[', '\\]'] : ['', ''];
  if (!open) return false;
  const rest = first.slice(open.length).trimEnd();
  let content: string;
  let last = startLine;
  if (rest.endsWith(close)) {
    const inner = rest.slice(0, -close.length);
    // $$a$$ and $$b$$: inline formulas in a paragraph, not a block.
    if (inner.includes(close)) return false;
    content = inner;
  } else {
    if (open === '\\[' && rest.trim()) return false;
    let found = false;
    for (let n = startLine + 1; n < endLine; n++) {
      if (state.isEmpty(n) || state.sCount[n]! < state.blkIndent) return false;
      const text = lineAt(n).trimEnd();
      if (text.endsWith(close)) {
        last = n;
        found = true;
        break;
      }
    }
    if (!found) return false;
    const middle = last > startLine + 1 ? state.getLines(startLine + 1, last, state.blkIndent, false) : '';
    const end = lineAt(last).trimEnd().slice(0, -close.length);
    content = [rest, middle, end].filter((s) => s.trim()).join('\n');
  }
  if (!content.trim()) return false;
  if (silent) return true;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content;
  token.markup = open;
  token.map = [startLine, last + 1];
  state.line = last + 1;
  return true;
}

// KaTeX's HTML, without its MathML copy, which the print would not show:
// an error is drawn in red with its source, never thrown; \href and the
// like stay off (trust: false).
function typeset(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, output: 'html', throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 50 });
  } catch {
    return `<code class="math-error">${escapeHtml(tex)}</code>`;
  }
}

export function math(md: MarkdownIt): void {
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.renderer.rules.math_inline = (tokens, idx, _options, env) => {
    (env as DocEnv).math = true;
    const t = tokens[idx]!;
    return t.markup === '$$' ? `<span class="math-display">${typeset(t.content, true)}</span>` : typeset(t.content, false);
  };
  md.renderer.rules.math_block = (tokens, idx, _options, env) => {
    (env as DocEnv).math = true;
    return `<div class="math-display">${typeset(tokens[idx]!.content, true)}</div>\n`;
  };
}

// Where a link leads in the PDF: as written, to the web or within the
// document; to the fragment alone when it names the document itself
// (README.md#install); nowhere (null) when it names a local file, which
// the reader cannot open and whose path would give the folder away, a
// user's name or a server's layout. Chromium writes such a link as the
// absolute file: URL. markdown-it refuses file: links themselves.
export function linkInPdf(href: string, base: string | undefined, document: string | undefined): string | null {
  if (!href || href.startsWith('#') || !base) return href;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return href;
  }
  if (url.protocol !== 'file:') return href;
  if (document && url.href.replace(/#.*$/, '') === document) return url.hash || null;
  return null;
}

// Links to local files become their text, in Markdown and in raw HTML,
// where such an <a> loses its href.
export function localLinks(md: MarkdownIt): void {
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const e = env as DocEnv;
    const t = tokens[idx]!;
    const href = linkInPdf(String(t.attrGet('href') ?? ''), e.base, e.document);
    (e.links ??= []).push(href !== null);
    if (href === null) return '';
    t.attrSet('href', href);
    return self.renderToken(tokens, idx, options);
  };
  // Links do not nest: the last open one is this close's.
  md.renderer.rules.link_close = (tokens, idx, options, env, self) => ((env as DocEnv).links?.pop() ?? true ? self.renderToken(tokens, idx, options) : '');
  md.core.ruler.push('local_links', (state: StateCore) => {
    const e = state.env as DocEnv;
    const strip = (html: string) => html.replace(/(<a\b[^>]*?)\s+href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (whole, head: string, value: string) => {
      const href = value.replace(/^(["'])(.*)\1$/s, '$2').replace(/&amp;/g, '&');
      const to = linkInPdf(href, e.base, e.document);
      return to === null ? head : to === href ? whole : `${head} href="${escapeHtml(to)}"`;
    });
    for (const t of state.tokens) {
      if (t.type === 'html_block') t.content = strip(t.content);
      else if (t.type === 'inline') for (const c of t.children ?? []) if (c.type === 'html_inline') c.content = strip(c.content);
    }
  });
}
