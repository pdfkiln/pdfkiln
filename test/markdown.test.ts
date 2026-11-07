// The Markdown renderer, without Chromium: front matter, GitHub's additions,
// math, and the page around the document.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { splitFrontMatter } from '../src/markdown/frontmatter.js';
import { slug } from '../src/markdown/plugins.js';
import { markdownPage } from '../src/markdown/render.js';

const base = 'file:///C:/docs/';
const page = (src: string, name?: string) => markdownPage(src, { base, name });
// The document's own HTML, without the page around it.
const body = (src: string) => {
  const html = page(src).html;
  const open = '<article class="markdown-body">';
  return html.slice(html.indexOf(open) + open.length, html.lastIndexOf('</article>')).trim();
};

describe('front matter', () => {
  test('the properties, quoted or not, keywords as a list or a string', () => {
    const { meta, body: rest } = splitFrontMatter([
      '---',
      'title: "Rapport : T3"',
      "author: 'O''Brien'",
      'subject: Ventes # a comment',
      'keywords: [ventes, "a, b"]',
      'lang: fr-FR',
      'layout: post',
      '---',
      '# Body',
    ].join('\n'));
    assert.deepEqual(meta, { title: 'Rapport : T3', author: "O'Brien", subject: 'Ventes', keywords: ['ventes', 'a, b'], lang: 'fr-FR' });
    assert.equal(rest, '# Body');
    assert.deepEqual(splitFrontMatter('---\nauthors:\n  - Ann\n  - Bob\ntags: x, y\n...\ntext').meta, { author: 'Ann, Bob', keywords: ['x', 'y'] });
  });

  test("real front matters: pandoc's, Hugo's, Jekyll's, read and never printed", () => {
    const read = (lines: string[]) => {
      const r = splitFrontMatter(['---', ...lines, '---', 'Body'].join('\n'));
      assert.equal(r.body, 'Body');
      return r.meta;
    };
    // pandoc: authors as maps, a literal block, a nested map.
    assert.deepEqual(read([
      'title: Rapport',
      'author:',
      '  - name: Ann Lee',
      '    affiliation: ACME',
      '  - name: "Bob: Jr"',
      'abstract: |',
      '  Two lines',
      '',
      '  # not a comment',
      'header-includes:',
      '  - \\usepackage{x}',
      'lang: fr-FR',
    ]), { title: 'Rapport', author: 'Ann Lee, Bob: Jr', lang: 'fr-FR' });
    // Hugo: a folded description, nested params, a key with a colon.
    assert.deepEqual(read([
      'title: "Post"',
      'description: >-',
      '  A folded',
      '  description.',
      'params:',
      '  toc: true',
      'og:image: /a.png',
      'tags: ["a", b]',
    ]), { title: 'Post', subject: 'A folded description.', keywords: ['a', 'b'] });
    // Jekyll: a list at the key's indentation, a plain title over two lines,
    // a quoted key; an author as a map.
    assert.deepEqual(read([
      '"layout": post',
      'title: A title that',
      '  goes on',
      'tags:',
      '- one',
      '- two',
      'author:',
      '  name: Ann',
      '  email: ann@example.com',
    ]), { title: 'A title that goes on', author: 'Ann', keywords: ['one', 'two'] });
  });

  test('a block that is not key: value, or not closed, is left to CommonMark', () => {
    for (const src of ['---\nTitle\n---\ntext', '---\ntitle: x\nno end', '\n---\ntitle: x\n---\n']) {
      const r = splitFrontMatter(src);
      assert.deepEqual(r.meta, {});
      assert.equal(r.body, src);
    }
    // A lang that html's lang cannot take is left out.
    assert.deepEqual(splitFrontMatter('---\nlang: "x\\" onload=y"\n---\n').meta, {});
  });
});

describe('math', () => {
  test('inline: $…$ and \\(…\\); displayed: $$…$$, \\[…\\], on their lines or in one', () => {
    for (const src of ['$x^2$', '\\(x^2\\)']) {
      const html = body(src);
      assert.match(html, /^<p><span class="katex">/, src);
      assert.doesNotMatch(html, /katex-display/, src);
    }
    for (const src of ['$$x^2$$', '\\[x^2\\]', '$$\nx^2\n$$', '\\[\nx^2\n\\]', 'Text\n$$\nx^2\n$$', 'a $$x^2$$ b']) {
      assert.match(body(src), /katex-display/, src);
    }
    // An unclosed $$ swallows no paragraph; references escaped by a converter
    // from HTML are no formula.
    assert.doesNotMatch(body('$$ is money.\n\nA paragraph.\n\nIt ends $$'), /katex/);
    assert.doesNotMatch(body('\\[1\\] Smith, 2020.\n\\[2\\] Doe, 2021. \\[link\\]'), /katex/);
    // In a list item, as chat assistants indent it.
    assert.match(body('1. Compute:\n   $$\n   x = 1\n   $$'), /<li>Compute:\n?<div class="math-display">/);
  });

  test('dollars that are not math stay text', () => {
    for (const src of ['It costs $5 and $10.', 'From $9.99 to $19.99', 'Save $10, not $ 20 $', 'a$b$c', 'An escaped \\$x\\$', '`$HOME` and `$x$`', '$$ alone', 'A price: $5']) {
      assert.doesNotMatch(body(src), /katex/, src);
    }
    assert.match(body('It costs $5 and $10.'), /It costs \$5 and \$10\./);
  });

  test("an error in red with its source; KaTeX's style sheet only when needed", () => {
    assert.match(body('$\\frac{1}{$'), /color:#cc0000|katex-error/);
    assert.match(page('$x$').html, /KaTeX_Main/);
    assert.match(page('$x$').html, /data:font\/woff2;base64,/);
    assert.doesNotMatch(page('no math').html, /KaTeX_Main/);
    assert.doesNotMatch(page('$x$').html, /url\(fonts\//);
  });
});

describe("GitHub's additions", () => {
  test('alerts, titled in the language of the front matter', () => {
    assert.equal(body('> [!WARNING]\n> Careful.'), '<div class="markdown-alert markdown-alert-warning">\n<p class="markdown-alert-title">Warning</p>\n<p>Careful.</p>\n</div>');
    assert.match(body('---\nlang: fr\n---\n> [!note]\n> Texte.'), /markdown-alert-note">\n<p class="markdown-alert-title">Remarque<\/p>/);
    assert.equal(body('> Not [!NOTE] an alert.'), '<blockquote>\n<p>Not [!NOTE] an alert.</p>\n</blockquote>');
    // A quote inside the alert closes as a quote.
    assert.match(body('> [!TIP]\n> > inner\n>\n> after'), /<blockquote>\n<p>inner<\/p>\n<\/blockquote>\n<p>after<\/p>\n<\/div>/);
  });

  test('task lists', () => {
    const html = body('- [ ] todo\n- [x] done\n- plain');
    assert.match(html, /^<ul class="contains-task-list">/);
    assert.match(html, /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> todo<\/li>/);
    assert.match(html, /disabled checked> done/);
    assert.match(html, /<li>plain<\/li>/);
  });

  test("heading anchors as GitHub's, and links to them", () => {
    assert.equal(slug('Hello, World! (v2)'), 'hello-world-v2');
    assert.equal(slug('Énoncé du problème'), 'énoncé-du-problème');
    assert.equal(slug('snake_case and-dash'), 'snake_case-and-dash');
    const html = body('# Setup\n## Setup\n## `npm` install\n[go](#setup-1)');
    assert.match(html, /<h1 id="setup">/);
    assert.match(html, /<h2 id="setup-1">/);
    assert.match(html, /<h2 id="npm-install">/);
    // Relative to the base, which Chromium reads as the document itself.
    assert.match(html, /<a href="#setup-1">/);
    // A heading named like a counted one, as github-slugger counts it.
    assert.deepEqual([...body('## a\n## a\n## a-1\n## a').matchAll(/ id="([^"]*)"/g)].map((m) => m[1]), ['a', 'a-1', 'a-1-1', 'a-2']);
  });

  test('footnotes numbered as GitHub, tables, strikethrough, emoji, bare links', () => {
    const html = body('A[^n] ~~old~~ :rocket: https://example.com\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n[^n]: Note.');
    assert.match(html, /<sup class="footnote-ref"><a href="#fn1" id="fnref1">1<\/a><\/sup>/);
    assert.match(html, /<s>old<\/s>/);
    assert.match(html, /🚀/);
    // Not :) nor 8), as GitHub.
    assert.match(body('Steps 8) and :) and :P'), /Steps 8\) and :\) and :P/);
    assert.match(html, /<a href="https:\/\/example.com">/);
    assert.match(html, /<td style="text-align:right">2<\/td>/);
  });

  test('code coloured when its language is known, as is otherwise', () => {
    assert.match(body('```js\nconst a = 1;\n```'), /<pre><code class="language-js"><span class="hljs-keyword">const<\/span>/);
    assert.equal(body('```mermaid\nA-->B\n```'), '<pre><code class="language-mermaid">A--&gt;B\n</code></pre>');
    assert.equal(body('```\n<b>\n```'), '<pre><code>&lt;b&gt;\n</code></pre>');
  });

  test('raw HTML kept, <details> opened for the paper', () => {
    assert.match(body('<p align="center"><img src="logo.png" width="96"></p>'), /<p align="center"><img src="logo.png" width="96"><\/p>/);
    assert.match(body('<details><summary>More</summary>\n\nHidden\n\n</details>'), /^<details open><summary>/);
    assert.match(body('<details open><summary>x</summary></details>'), /^<details open><summary>/);
    assert.equal(body('```\n<details>\n```'), '<pre><code>&lt;details&gt;\n</code></pre>');
  });
});

describe('links', () => {
  const doc = 'file:///C:/docs/README.md';
  const links = (src: string, document?: string) => {
    const html = markdownPage(src, { base, document }).html;
    return html.slice(html.indexOf('<article class="markdown-body">') + 31, html.lastIndexOf('</article>')).trim();
  };

  test('to a local file: its text, no link; to the web or within the document: kept', () => {
    assert.equal(links('[guide](docs/guide.md) [up](../x.md) [root](/etc/x) [web](https://example.com/a) [mail](mailto:a@example.com) [here](#install)'),
      '<p>guide up root <a href="https://example.com/a">web</a> <a href="mailto:a@example.com">mail</a> <a href="#install">here</a></p>');
    // A badge that links to a local file keeps its image.
    assert.equal(links('[![CI](ci.svg)](LICENSE)'), '<p><img src="ci.svg" alt="CI"></p>');
    // markdown-it refuses file: links itself.
    assert.doesNotMatch(links('[x](file:///C:/secret.txt)'), /href/);
  });

  test('to the document itself: the fragment alone, nothing without one', () => {
    assert.equal(links('[a](README.md#install) [b](./README.md) [c](other.md#install)', doc), '<p><a href="#install">a</a> b c</p>');
  });

  test('in raw HTML: a local <a> loses its href, the others keep theirs', () => {
    assert.equal(links('<p><a class="x" href="docs/guide.md">guide</a> <a href=\'https://example.com\'>web</a> <a href=README.md#top>top</a></p>', doc),
      '<p><a class="x">guide</a> <a href=\'https://example.com\'>web</a> <a href="#top">top</a></p>');
    assert.equal(links('See <a href="CONTRIBUTING.md">the guide</a>.'), '<p>See <a>the guide</a>.</p>');
    // In code, a link is text.
    assert.equal(links('```html\n<a href="x.md">\n```'), '<pre><code class="language-html"><span class="hljs-tag">&lt;<span class="hljs-name">a</span> <span class="hljs-attr">href</span>=<span class="hljs-string">&quot;x.md&quot;</span>&gt;</span>\n</code></pre>');
  });
});

describe('the page', () => {
  test('its title: front matter, first heading, HTML heading, then the name', () => {
    const title = (src: string) => /<title>(.*)<\/title>/.exec(page(src, 'file').html)?.[1];
    assert.equal(title('---\ntitle: From <front>\n---\n# Heading'), 'From &lt;front&gt;');
    assert.equal(title('## Not this\n# Heading *one*'), 'Heading one');
    assert.equal(title('<h1 align="center">Acme &amp; <img src="x"> CLI</h1>'), 'Acme &amp; CLI');
    assert.equal(title('text'), 'file');
    assert.doesNotMatch(markdownPage('text', { base }).html, /<title>/);
  });

  test('its language, base and style sheets', () => {
    const { html, meta } = page('---\nlang: fr\nauthor: Ann\n---\ntext');
    assert.match(html, /^<!doctype html>\n<html lang="fr">/);
    assert.match(html, /<base href="file:\/\/\/C:\/docs\/">/);
    assert.match(html, /hljs-keyword/);
    assert.match(html, /@bottom-center \{ content: counter\(page\) " \/ " counter\(pages\)/);
    assert.deepEqual(meta, { author: 'Ann', lang: 'fr' });
    assert.match(page('text').html, /^<!doctype html>\n<html>/);
    assert.match(markdownPage('x', { base: 'file:///C:/a%22b/' }).html, /<base href="file:\/\/\/C:\/a%22b\/">/);
  });
});
