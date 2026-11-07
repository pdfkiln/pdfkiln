// pdfkiln's style sheet for Markdown: a document to read on paper. GitHub's
// colours and proportions; nothing that a page break would cut badly (a
// code block, a table row, a formula, a picture, a heading from what
// follows it); page numbers at the foot. --css comes after it and wins.

// The page's margins, in cm; the internal links' targets move by them.
export const MARGIN_TOP_CM = 2;
export const MARGIN_LEFT_CM = 2.2;

const SANS = '-apple-system, "Segoe UI", "Noto Sans", "Liberation Sans", "Helvetica Neue", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", "DejaVu Sans Mono", Menlo, monospace, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

export const STYLE = `
@page {
  margin: ${MARGIN_TOP_CM}cm ${MARGIN_LEFT_CM}cm 2.4cm;
  @bottom-center { content: counter(page) " / " counter(pages); font: 8.5pt/1 ${SANS}; color: #59636e; }
}
html { font: 10.5pt/1.55 ${SANS}; color: #1f2328; background: #fff; }
body { margin: 0; }
.markdown-body { overflow-wrap: break-word; }
.markdown-body > :first-child { margin-top: 0 !important; }
.markdown-body > :last-child { margin-bottom: 0 !important; }

h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 .6em; font-weight: 600; line-height: 1.25; break-after: avoid; break-inside: avoid; }
h1 { font-size: 1.9em; padding-bottom: .25em; border-bottom: 1px solid #d1d9e0; }
h2 { font-size: 1.45em; padding-bottom: .2em; border-bottom: 1px solid #d1d9e0; }
h3 { font-size: 1.2em; }
h4 { font-size: 1em; }
h5 { font-size: .9em; }
h6 { font-size: .85em; color: #59636e; }

p, blockquote, ul, ol, dl, table, pre, details, .math-display, .markdown-alert, .footnotes { margin: 0 0 .9em; }
p { orphans: 2; widows: 2; }
a { color: #0969da; text-decoration: none; }
strong, b { font-weight: 600; }
hr { height: 0; margin: 1.5em 0; border: 0; border-top: 1px solid #d1d9e0; }
img, svg, video { max-width: 100%; height: auto; break-inside: avoid; }
img { border-style: none; }
mark { background: #fff8c5; color: inherit; }
sup, sub { line-height: 0; }

ul, ol { padding-left: 1.9em; }
ul ul, ul ol, ol ol, ol ul { margin-top: .2em; margin-bottom: 0; }
li + li { margin-top: .2em; }
li > p { margin: .4em 0; }
dt { margin-top: .8em; font-weight: 600; }
dd { margin: 0 0 .4em; padding-left: 1em; }
.contains-task-list { padding-left: 1.4em; list-style: none; }
.contains-task-list .contains-task-list { padding-left: 1.6em; }
.task-list-item-checkbox { margin: 0 .4em 0 -1.4em; vertical-align: -.1em; }

blockquote { padding: 0 1em; color: #59636e; border-left: .25em solid #d1d9e0; }
.markdown-alert { padding: .5em 1em; border-left: .25em solid #d1d9e0; break-inside: avoid; }
.markdown-alert > :last-child { margin-bottom: 0; }
.markdown-alert-title { margin: 0 0 .3em !important; font-weight: 600; }
.markdown-alert-note { border-left-color: #0969da; } .markdown-alert-note .markdown-alert-title { color: #0969da; }
.markdown-alert-tip { border-left-color: #1a7f37; } .markdown-alert-tip .markdown-alert-title { color: #1a7f37; }
.markdown-alert-important { border-left-color: #8250df; } .markdown-alert-important .markdown-alert-title { color: #8250df; }
.markdown-alert-warning { border-left-color: #9a6700; } .markdown-alert-warning .markdown-alert-title { color: #9a6700; }
.markdown-alert-caution { border-left-color: #d1242f; } .markdown-alert-caution .markdown-alert-title { color: #d1242f; }

code, kbd, samp, pre, tt { font-family: ${MONO}; }
:not(pre) > code { padding: .15em .35em; font-size: 86%; background: #eff1f3; border-radius: 4px; }
pre { padding: .9em 1em; font-size: 84%; line-height: 1.45; background: #f6f8fa; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
pre code { padding: 0; font-size: 100%; background: none; white-space: inherit; }
kbd { display: inline-block; padding: .1em .4em; font-size: 80%; line-height: 1.2; background: #f6f8fa; border: 1px solid #d1d9e0; border-bottom-width: 2px; border-radius: 4px; }

table { border-collapse: collapse; border-spacing: 0; max-width: 100%; font-size: 95%; font-variant-numeric: tabular-nums; }
th, td { padding: .35em .8em; border: 1px solid #d1d9e0; overflow-wrap: anywhere; }
th { font-weight: 600; text-align: start; background: #f6f8fa; }
tbody tr:nth-child(2n) { background: #f6f8fa; }
tr { break-inside: avoid; }
td > :last-child, th > :last-child { margin-bottom: 0; }

.math-display { display: block; overflow-wrap: normal; break-inside: avoid; }
.katex-display { margin: .6em 0; }
.math-error { color: #d1242f; }

.footnotes { font-size: 86%; color: #59636e; }
.footnotes-sep { margin-top: 2em; break-after: avoid; }
.footnotes ol { padding-left: 1.6em; }
.footnote-ref a, .footnote-backref { text-decoration: none; }

details > summary { font-weight: 600; }
`;
