// The style sheets a Markdown document may need besides pdfkiln's own:
// KaTeX's, with its WOFF2 fonts inlined, the page reading no file for them,
// and the GitHub theme of highlight.js. The bundle embeds them
// (scripts/bundle.ts); from the sources, they are read from node_modules.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface MarkdownAssets {
  katex: string;
  highlight: string;
}

declare const PDFKILN_MARKDOWN_ASSETS: MarkdownAssets | undefined;

// KaTeX's style sheet, each @font-face down to its WOFF2 file, as a data:
// URL: Chromium reads WOFF2, and the older formats would only add weight.
export function readMarkdownAssets(from: string): MarkdownAssets {
  const require = createRequire(from);
  const katexCss = require.resolve('katex/dist/katex.min.css');
  const fonts = dirname(katexCss);
  const katex = readFileSync(katexCss, 'utf8').replace(/src:url\(([^)]+\.woff2)\) format\("woff2"\)[^;}]*/g, (_, file: string) =>
    `src:url(data:font/woff2;base64,${readFileSync(join(fonts, file)).toString('base64')}) format("woff2")`);
  if (/url\(fonts\//.test(katex)) throw new Error('KaTeX style sheet: a font left out of the inlining');
  const highlight = readFileSync(require.resolve('highlight.js/styles/github.min.css'), 'utf8');
  return { katex, highlight };
}

let read: MarkdownAssets | undefined;

export function markdownAssets(): MarkdownAssets {
  if (typeof PDFKILN_MARKDOWN_ASSETS !== 'undefined') return PDFKILN_MARKDOWN_ASSETS;
  return (read ??= readMarkdownAssets(import.meta.url));
}
