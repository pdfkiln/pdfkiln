// What the compatible mode takes out of a page before Chromium reads it:
// the addresses WebKit 534 never loaded (src/engine/webkit534-loads.ts).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tokenize } from '../src/engine/css-tokens.js';
import { cleanCss, cleanDocument, cleanHtml, cleanXml, htmlEncoding } from '../src/engine/webkit534-loads.js';

const off = { scripting: false, depth: 0 };
const on = { scripting: true, depth: 0 };
// The text of a data: URL.
const dataText = (url: string) => {
  const m = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url)!;
  return m[1] ? Buffer.from(m[2]!, 'base64').toString('utf8') : decodeURIComponent(m[2]!);
};
const attrOf = (html: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, '&') ?? '';

describe('CSS', () => {
  test('the tokenizer resolves escapes in names and keeps places', () => {
    const t = tokenize('a{b:\\69mage-set("x" 1x)}');
    const f = t.find((x) => x.type === 'function')!;
    assert.equal(f.value, 'image-set');
    assert.equal('a{b:\\69mage-set("x" 1x)}'.slice(f.start, f.end), '\\69mage-set(');
    assert.deepEqual(tokenize('url( a\\)b )').map((x) => [x.type, x.value]), [['url', 'a)b']]);
    assert.deepEqual(tokenize('url( "a" )').map((x) => x.type), ['function', 'whitespace', 'string', 'whitespace', ')']);
  });

  test('a declaration with image-set() or -webkit-image-set() goes, whatever its case or escapes', () => {
    assert.equal(cleanCss('body{color:red;background-image:image-set("http://x/a.png" 1x);margin:0}'), 'body{color:red;margin:0}');
    assert.equal(cleanCss('p{background:\\69mage-set("http://x" 1x)}'), 'p{}');
    assert.equal(cleanCss('p{background:IMAGE-SET(url(x) 1x)}'), 'p{}');
    assert.equal(cleanCss('p{background:-webkit-cross-fade(image-set("a" 1x),url(b),50%) !important}'), 'p{}');
    assert.equal(cleanCss('p{x:-WEBKIT-image-set("a" 1x); y:1}'), 'p{ y:1}');
  });

  test('a string or a comment that names image-set stays', () => {
    const css = 'p{content:"image-set(x)"}/* image-set( */q{background:url(http://x/a.png)}';
    assert.equal(cleanCss(css), css);
  });

  test('custom properties, nested rules and preludes', () => {
    assert.equal(cleanCss(':root{--x:image-set("http://x" 1x)}p{background:var(--x)}'), ':root{}p{background:var(--x)}');
    assert.equal(cleanCss('div{& p{background:image-set("a" 1x)}color:red}'), 'div{& p{}color:red}');
    assert.equal(cleanCss('@supports (background:image-set("a" 1x)){p{color:red}}q{}'), 'q{}');
  });

  test('the declarations of a style attribute', () => {
    assert.equal(cleanCss("color:red; background: image-set('a' 1x); margin:0"), 'color:red; margin:0');
  });

  test('an @import of a data: style sheet is cleaned', () => {
    const css = '@import url("data:text/css,p%7Bbackground:image-set(%22http://x%22%201x)%7D");p{}';
    const out = cleanCss(css);
    const url = /url\("([^"]+)"\)/.exec(out)![1]!;
    assert.equal(dataText(url), 'p{}');
  });
});

describe('CSS that WebKit 534 did not read, where it loads an address', () => {
  test('properties it did not load a url() of, functions it did not know, a background it did not parse', () => {
    assert.equal(cleanCss('div{mask-image:url(m.png);color:red}'), 'div{color:red}');
    assert.equal(cleanCss('div{-webkit-mask-image:url(m.png)}'), 'div{-webkit-mask-image:url(m.png)}');
    assert.equal(cleanCss('div{border-image:url(b.png) 10;shape-outside:url(s.png);clip-path:url(c.svg#c)}'), 'div{}');
    assert.equal(cleanCss('div{clip-path:url(#c)}'), 'div{clip-path:url(#c)}');
    assert.equal(cleanCss('p{background-image:linear-gradient(red,blue),url(a.png)}'), 'p{}');
    assert.equal(cleanCss('p{background-image:-webkit-linear-gradient(red,blue),url(a.png)}'), 'p{background-image:-webkit-linear-gradient(red,blue),url(a.png)}');
    assert.equal(cleanCss('p{background:url(a.png) calc(10px) 0}q{background:url(a.png) min(1px,2px) 0}'), 'p{}q{}');
    assert.equal(cleanCss('p{background:url(a.png) center/cover}q{background:url(a.png) right 10px top 5px}'), 'p{}q{}');
    assert.equal(cleanCss('p{background:rgba(0,0,0,.5) url(a.png) no-repeat 0 0}'), 'p{background:rgba(0,0,0,.5) url(a.png) no-repeat 0 0}');
    assert.equal(cleanCss(':root{--x:url(a.png)}p{background:var(--x)}'), ':root{}p{background:var(--x)}');
    assert.equal(cleanCss('--x:url(a.png);background-image:var(--x)'), 'background-image:var(--x)');
  });

  test('an address in data: or within the document stays, whatever holds it', () => {
    const css = 'div{mask-image:url(data:image/png;base64,AA);fill:url(#g)}@supports (x:y){p{background:url("data:image/svg+xml,%3Csvg/%3E")}}';
    assert.equal(cleanCss(css), css);
  });

  test('rules it did not apply: at-rules, nesting, selectors', () => {
    assert.equal(cleanCss('@supports (display:grid){p{background:url(a.png);color:red}}'), '@supports (display:grid){p{color:red}}');
    assert.equal(cleanCss('@layer x{p{background:url(a.png)}}@keyframes k{from{background:url(a.png)}}'), '@layer x{p{}}@keyframes k{from{}}');
    assert.equal(cleanCss('@-webkit-keyframes k{from{background:url(a.png)}}'), '@-webkit-keyframes k{from{background:url(a.png)}}');
    assert.equal(cleanCss('div{color:red;& p{background:url(a.png)}}'), 'div{color:red;& p{}}');
    for (const sel of [':is(p)', ':where(p)', 'div:has(span)', 'div:focus-within', '[class="b" i]', 'div:not(.a .b)', 'div:nth-child(1 of .b)', 'div, :is(p)', 'p::marker']) {
      assert.equal(cleanCss(`${sel}{background:url(a.png)}`), `${sel}{}`, sel);
    }
    for (const sel of ['div > p + a ~ b', 'p:first-child', 'a:not(.x)', 'li:nth-child(2n+1)', ':-webkit-any(div,p)', 'p::before', 'p:after', '[href^="http"]', 'svg|rect', '*']) {
      assert.equal(cleanCss(`${sel}{background:url(a.png)}`), `${sel}{background:url(a.png)}`, sel);
    }
  });

  test('media queries: a feature it did not know, or a syntax, made the query false; @import loaded whatever its media', () => {
    for (const q of ['(width >= 0px)', '(prefers-color-scheme: light)', 'screen or print', '(min-resolution: 2dppx)']) {
      assert.equal(cleanCss(`@media ${q}{p{background:url(a.png)}}`), `@media ${q}{p{}}`, q);
    }
    for (const q of ['screen', 'print', '(min-width: 500px)', 'screen and (max-width: 100px)', '(-webkit-min-device-pixel-ratio: 2)', '(orientation: portrait)']) {
      assert.equal(cleanCss(`@media ${q}{p{background:url(a.png)}}`), `@media ${q}{p{background:url(a.png)}}`, q);
    }
    assert.equal(cleanCss('@import url(s.css) print;@import url(t.css) (width >= 0);@import url(u.css) layer(x);@import "v.css" supports(display:grid);p{}'), '@import url(s.css) print;p{}');
  });

  // Google Fonts gives Chromium's user agent woff2 alone, where it gave
  // wkhtmltopdf's TrueType: without it, no font at all.
  test('@font-face: every source stays, woff2 too; tech() made src invalid', () => {
    assert.equal(cleanCss('@font-face{font-family:x;src:url(a.woff2) format("woff2"),url(b.woff) format("woff")}'), '@font-face{font-family:x;src:url(a.woff2) format("woff2"),url(b.woff) format("woff")}');
    assert.equal(cleanCss("@font-face{font-family:x;src:url(a.woff2) format('woff2');unicode-range:U+0000-00FF}"), "@font-face{font-family:x;src:url(a.woff2) format('woff2');unicode-range:U+0000-00FF}");
    assert.equal(cleanCss('@font-face{font-family:x;src:local(X),url(a.ttf) format("truetype")}'), '@font-face{font-family:x;src:local(X),url(a.ttf) format("truetype")}');
    assert.equal(cleanCss('@font-face{font-family:x;src:url(a.woff2) format("woff2") tech(variations)}'), '@font-face{font-family:x;}');
    assert.equal(cleanCss('@font-face{font-family:x;src:url(a.woff)}@page{background:url(a.png)}'), '@font-face{font-family:x;src:url(a.woff)}@page{}');
  });
});

describe('HTML', () => {
  test('srcset, sizes, imagesrcset and the links that are no style sheet', () => {
    assert.equal(cleanHtml('<img src="a.png" srcset="b.png 2x" sizes="10px">', off), '<img src="a.png">');
    assert.equal(cleanHtml('<picture><source srcset="b.png" type="image/webp"><img src="a.png"></picture>', off), '<picture><source type="image/webp"><img src="a.png"></picture>');
    assert.equal(cleanHtml('<link rel="preload" as="image" href="a.png" imagesrcset="b.png 1x">', off), '<link rel="preload" as="image">');
    assert.equal(cleanHtml('<link rel=prefetch href=p.html><link rel="Stylesheet preload" href="s.css">', off), '<link rel="prefetch"><link rel="Stylesheet preload" href="s.css">');
  });

  test('media and srcdoc', () => {
    assert.equal(cleanHtml('<video poster="p.png" src="v.mp4"><source src="w.mp4"><track src="t.vtt"></video><audio src="a.mp3"></audio>', off), '<video><source><track></video><audio></audio>');
    assert.equal(cleanHtml('<iframe src="f.html" srcdoc="<img src=x>"></iframe>', off), '<iframe src="f.html"></iframe>');
  });

  test('SVG: href without xlink: to another document, references into another document', () => {
    const out = cleanHtml('<svg><image href="http://x/a.png"/><image xlink:href="http://x/b.png"/><use href="#s"/><a href="http://x/l">t</a><rect fill="url(other.svg#g)" stroke="url(#local)"/></svg>', off);
    assert.equal(out, '<svg><image /><image xlink:href="http://x/b.png"/><use href="#s"/><a href="http://x/l">t</a><rect stroke="url(#local)" /></svg>');
  });

  test('style elements and attributes, entities of SVG read as Chromium reads them', () => {
    assert.equal(cleanHtml('<style>p{background:image-set("http://x" 1x)}</style>', off), '<style>p{}</style>');
    assert.equal(cleanHtml('<svg><style>p{background:image&#45;set("http://x" 1x)}</style></svg>', off), '<svg><style>p{}</style></svg>');
    assert.equal(cleanHtml(`<p style="color:red;background:image-set('http://x' 1x)">x</p>`, off), '<p style="color:red;">x</p>');
  });

  test('<noscript> as Chromium parses it, templates, attributes given twice', () => {
    assert.equal(cleanHtml('<noscript><img srcset="x 1x"></noscript>', off), '<noscript><img></noscript>');
    assert.equal(cleanHtml('<noscript><img srcset="x 1x"></noscript>', on), '<noscript><img srcset="x 1x"></noscript>');
    assert.equal(cleanHtml('<template><img srcset="x"></template>', off), '<template><img></template>');
    assert.equal(cleanHtml('<img srcset="data:," srcset="http://x 1x" src="a">', off), '<img src="a">');
  });

  test('data: documents and style sheets, which Chromium reads without the Fetch domain', () => {
    const frame = cleanHtml('<iframe src="data:text/html,%3Cimg%20srcset%3D%22http://x%201x%22%3E"></iframe>', off);
    assert.equal(dataText(attrOf(frame, 'src')), '<img>');
    const object = cleanHtml(`<object type="image/svg+xml" data="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cimage href='http://x/a.png'/%3E%3C/svg%3E"></object>`, off);
    assert.equal(dataText(attrOf(object, 'data')), '<svg xmlns="http://www.w3.org/2000/svg"><image/></svg>');
    const sheet = cleanHtml('<link rel="stylesheet" href="data:text/css,p{background:image-set(%22http://x%22 1x)}">', off);
    assert.equal(dataText(attrOf(sheet, 'href')), 'p{}');
    const refresh = cleanHtml(`<meta http-equiv="refresh" content="0; url='data:text/html,%3Cimg srcset=http://x%3E'">`, off);
    const target = /url='([^']+)'/.exec(attrOf(refresh, 'content'))![1]!;
    assert.equal(dataText(target), '<img>');
  });

  test('a page with nothing to take out comes back as it was', () => {
    const page = '<!DOCTYPE html><html><head><link rel="stylesheet" href="s.css"><style>p{background:url(a.png)}</style></head><body><img src="a.png" alt="é"><svg><use xlink:href="#a"/></svg></body></html>';
    assert.equal(cleanHtml(page, off), page);
  });
});

describe('XML documents', () => {
  test('SVG 2 href and style elements; xlink:href stays', () => {
    const svg = '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style><![CDATA[p{background:image-set("http://x" 1x)}]]></style><image href="http://x/a.png"/><image xlink:href="http://x/b.png"/></svg>';
    assert.equal(cleanXml(svg, off), '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><style>p{}</style><image/><image xlink:href="http://x/b.png"/></svg>');
  });

  test('unchanged, it comes back as it was; not well-formed or with a DTD of its own, it cannot be read', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#g)"/></svg>';
    assert.equal(cleanXml(svg, off), svg);
    assert.equal(cleanXml('<svg><g></svg>', off), null);
    assert.equal(cleanXml('<!DOCTYPE svg [<!ENTITY x "image-set">]><svg xmlns="http://www.w3.org/2000/svg"/>', off), null);
  });
});

describe('encodings', () => {
  test('a page is read in the encoding it declares, a Shift_JIS backslash included', () => {
    // 表 is 0x95 0x5C in Shift_JIS: read as Latin-1, its second byte would
    // escape the quote that ends the string.
    const page = Buffer.concat([
      Buffer.from('<meta charset="shift_jis"><style>p{content:"'), Buffer.from([0x95, 0x5c]),
      Buffer.from('"}body{background:image-set("http://x" 1x)}</style>'),
    ]);
    const c = cleanDocument(page, 'text/html', false)!;
    assert.equal(c.changed, true);
    assert.equal(c.contentType, 'text/html; charset=utf-8');
    assert.equal(c.body.toString('utf8'), '<meta charset="shift_jis"><style>p{content:"表"}body{}</style>');
  });

  test('the rewriting of the styles for the emulations: done in the page in UTF-8 or windows-1252, left to the printing in Shift_JIS', () => {
    const rewrite = (css: string) => css.replace('display:flex', '');
    const sjis = Buffer.concat([Buffer.from('<meta charset="shift_jis"><style>p{display:flex}</style><p>'), Buffer.from([0x83, 0xbf]), Buffer.from('</p>')]);
    const c = cleanDocument(sjis, 'text/html', false, rewrite)!;
    assert.equal(c.changed, false);
    assert.equal(c.contentType, 'text/html; charset=shift_jis');
    assert.equal(c.body, sjis);
    const utf8 = cleanDocument(Buffer.from('<style>p{display:flex}</style><p>é</p>', 'utf8'), 'text/html', false, rewrite)!;
    assert.equal(utf8.changed, true);
    assert.equal(utf8.body.toString('utf8'), '<style>p{}</style><p>é</p>');
  });

  // Chromium guesses the encoding of a page whose type declares none:
  // Shift_JIS, where ソ (0x83 0x5C) is one character. Read in windows-1252,
  // its second byte escapes the quote that ends the string, which then
  // holds the image-set(: served with the charset it was read in.
  test('a page whose type declares no charset: guessed, unless ASCII, with a BOM, or a response without a type', () => {
    const page = Buffer.concat([Buffer.from('<style>p{--a:"'), Buffer.from([0x83, 0x5c]), Buffer.from('";background-image:image-set("http://x" 1x)}</style>')]);
    const c = cleanDocument(page, 'text/html', false)!;
    assert.deepEqual([c.changed, c.guessed, c.contentType], [false, true, 'text/html; charset=windows-1252']);
    const d = cleanDocument(page, 'text/html; charset=shift_jis', false)!;
    assert.deepEqual([d.changed, d.guessed], [true, false]);
    assert.equal(cleanDocument(Buffer.from('<p>plain</p>'), 'text/html', false)!.guessed, false);
    assert.equal(cleanDocument(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>é</p>')]), 'text/html', false)!.guessed, false);
    assert.equal(cleanDocument(page, undefined, false)!.guessed, false);
  });

  test('UTF-16 with its BOM; windows-1252 written again as such', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<img srcset="http://x 1x">', 'utf16le')]);
    const c = cleanDocument(utf16, 'text/html', false)!;
    assert.equal(c.body.toString('utf8'), '<img>');
    assert.equal(c.contentType, 'text/html; charset=utf-8');
    const latin = Buffer.from('<meta charset="windows-1252"><p>\xe9</p><img srcset="x">', 'latin1');
    const d = cleanDocument(latin, 'text/html', false)!;
    assert.equal(d.contentType, 'text/html; charset=windows-1252');
    assert.equal(d.body.toString('latin1'), '<meta charset="windows-1252"><p>\xe9</p><img>');
  });

  test('a page that declares none: UTF-8 when it is, else windows-1252, as wkhtmltopdf reads it', () => {
    assert.equal(htmlEncoding(Buffer.from('<p>café</p>', 'utf8')), 'utf-8');
    assert.equal(htmlEncoding(Buffer.from('<p>caf\xe9</p>', 'latin1')), 'windows-1252');
    assert.equal(htmlEncoding(Buffer.from('<p>plain</p>')), 'windows-1252');
    assert.equal(htmlEncoding(Buffer.from('<!--' + 'x'.repeat(1100) + '--><meta charset="shift_jis">')), 'shift_jis');
    assert.equal(htmlEncoding(Buffer.from('<meta charset="utf-16">')), 'utf-8');
    const c = cleanDocument(Buffer.from('<p>plain</p>'), 'text/html; charset=iso-8859-2', false)!;
    assert.equal(c.changed, false);
    assert.equal(c.contentType, 'text/html; charset=iso-8859-2');
  });
});
