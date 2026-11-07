// A Markdown document as the HTML page pdfkiln prints: GitHub's dialect
// (tables, strikethrough, task lists, alerts, footnotes, emoji shortcodes,
// bare links, raw HTML, heading anchors), math typeset by KaTeX, code
// coloured by highlight.js when its block names a known language, and the
// properties of its front matter. Loaded on demand: an HTML conversion does
// not pay for it.
import hljs from 'highlight.js/lib/common';
import MarkdownIt, { type MarkdownIt as Parser } from 'markdown-it';
import { full as emoji } from 'markdown-it-emoji';
import footnote from 'markdown-it-footnote';
import { markdownAssets } from './assets.js';
import { splitFrontMatter, type FrontMatter } from './frontmatter.js';
import { alerts, anchors, localLinks, math, taskLists, type DocEnv } from './plugins.js';
import { STYLE } from './style.js';

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let parser: Parser | undefined;

function markdown(): Parser {
  if (parser) return parser;
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: (code, lang) => {
      const name = lang.trim().toLowerCase();
      if (!name || !hljs.getLanguage(name)) return '';
      try {
        return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
      } catch {
        return '';
      }
    },
  });
  // Emoji by their names (:rocket:), not :) or :P, which GitHub leaves as
  // they are and a technical text writes as text.
  md.use(footnote).use(emoji, { shortcuts: {} }).use(taskLists).use(alerts).use(anchors).use(math).use(localLinks);
  // GitHub's footnote marks: 1, not [1].
  md.renderer.rules.footnote_caption = (tokens, idx) => {
    const meta = tokens[idx]!.meta as { id: number; subId: number };
    return `${meta.id + 1}${meta.subId > 0 ? `:${meta.subId}` : ''}`;
  };
  return (parser = md);
}

// The parser and the style sheets, ready before the first document: the
// native interface calls it while Chromium starts (about 20 ms).
export function prepare(): void {
  markdown();
  markdownAssets();
}

// The text of a first <h1> written in HTML, as READMEs center theirs.
function htmlH1(html: string): string | undefined {
  const inner = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  const text = inner?.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!).replace(/\s+/g, ' ').trim();
  return text || undefined;
}

export interface MarkdownPage {
  html: string;
  meta: FrontMatter;
}

export interface PageOptions {
  // What relative links and images resolve against: the document's folder,
  // as a file: URL ending in /. A link to #section stays inside the PDF:
  // Chromium compares it with the base, not with the page's own URL.
  base: string;
  // The document itself, a file: URL, when it is a file: a link to it with
  // a fragment (README.md#install) leads within the PDF.
  document?: string;
  // The title when the front matter gives none and no heading of level 1
  // comes: the file's name without its extension.
  name?: string;
}

export function markdownPage(src: string, opts: PageOptions): MarkdownPage {
  const { meta, body } = splitFrontMatter(src);
  const env: DocEnv = { lang: meta.lang, base: opts.base, document: opts.document };
  let html = markdown().render(body, env);
  // <details>, which the paper cannot open, opened; in a code block, < is
  // &lt;: no tag there.
  html = html.replace(/<details(?![^>]*\sopen\b)/gi, '<details open');
  const title = meta.title ?? env.firstH1 ?? htmlH1(html) ?? opts.name;
  const assets = markdownAssets();
  const page = [
    '<!doctype html>',
    meta.lang ? `<html lang="${escapeHtml(meta.lang)}">` : '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<base href="${escapeHtml(opts.base)}">`,
    title ? `<title>${escapeHtml(title)}</title>` : '',
    `<style>${assets.highlight}</style>`,
    env.math ? `<style>${assets.katex}</style>` : '',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<article class="markdown-body">',
    html,
    '</article>',
    '</body>',
    '</html>',
    '',
  ];
  return { html: page.filter(Boolean).join('\n'), meta };
}
