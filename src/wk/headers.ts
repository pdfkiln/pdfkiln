// Headers and footers of the compatible mode, drawn after the body is
// printed (src/lib/pdfconverter.cc endPage, loadHeaders):
// - header-left/center/right and their footer-* twins, with the variables
//   replaced, are laid out in one HTML document, one page per body page;
// - header-html and footer-html are loaded with wkhtmltopdf's URL
//   parameters, one <iframe> per page in one document printed at once.
// Each result is stamped on the body page.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PDFDocument, PDFPage } from '@cantoo/pdf-lib';
import type { BrowserContext } from 'puppeteer-core';
import { markFrames, printApart, printer } from '../engine/frames.js';
import { qtFallbackFamily, sfntFamilies } from '../engine/fonts.js';
import { emulate, openPage, type LoadedPage, type LoadSpec, type Reporter } from '../engine/loader.js';
import { pdfModules, READ, WRITE } from '../pdf/modules.js';
import type { HeaderFooter } from './settings.js';

const PT_PER_MM = 72 / 25.4;
const PX_PER_MM = 96 / 25.4;

// [time] and [date], as Qt 4.8's SystemLocaleShortDate gives them to
// wkhtmltopdf 0.12.6 (pdfconverter.cc). On Windows, the system's own
// formats: its time has the seconds. On Linux, the locale of LC_ALL,
// LC_TIME or LANG, as Qt reads them; without one (C, POSIX), Qt's:
// 16:37:26 and 17 Nov 2026. A named locale keeps the short styles, which
// match Qt's for en_US, en_GB and de_DE (measured 17/11/2026; for fr_FR,
// Qt writes the year in two digits). macOS, not measured, keeps them too.
export function qtDateTime(now: Date, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { time: string; date: string } {
  const short = (locale?: string) => ({
    time: now.toLocaleTimeString(locale, { timeStyle: 'short' }),
    date: now.toLocaleDateString(locale, { dateStyle: 'short' }),
  });
  if (platform === 'win32') return { ...short(), time: now.toLocaleTimeString(undefined, { timeStyle: 'medium' }) };
  if (platform !== 'linux') return short();
  const name = env.LC_ALL || env.LC_TIME || env.LANG || 'C';
  if (/^(C|POSIX)([._@]|$)/.test(name)) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()];
    return { time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`, date: `${now.getDate()} ${month} ${now.getFullYear()}` };
  }
  // fr_FR.UTF-8 as fr-FR; a name Intl does not know, its default locale.
  const tag = name.replace(/[.@].*$/, '').replace(/_/g, '-');
  let locale: string | undefined;
  try {
    locale = Intl.DateTimeFormat.supportedLocalesOf(tag)[0];
  } catch {
    locale = undefined;
  }
  return short(locale);
}

export interface Geometry {
  width: number; // mm, page
  height: number;
  top: number; // mm, margins of the content
  bottom: number;
  left: number;
  right: number;
}

// src/lib/outline.cc fillHeaderFooterParms and pdfconverter.cc fillParms.
export type Parms = Record<string, string>;

export function hfreplace(q: string, parms: Parms): string {
  let r = q;
  for (const [k, v] of Object.entries(parms)) {
    r = r.replace(new RegExp(`\\[${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'gi'), () => v);
  }
  return r;
}

// A key or a value of the query, as Qt 4.8's QUrl::addQueryItem writes it
// (qurl.cpp, queryExcludeChars): !$'()*+,;:@/? stay as they are, = and &
// are encoded, being its delimiters, and so is a space, as %20.
const queryItem = (s: string) => encodeURIComponent(s).replace(/%(24|2B|2C|3B|3A|40|2F|3F)/g, (m) => decodeURIComponent(m));

// The URL of a header-html page with the page's parameters added to its
// query (pdfconverter.cc loadHeaderFooter); the rest of the URL as given.
export function withParms(url: string, parms: Parms): string {
  const u = new URL(url);
  const hash = u.hash;
  u.hash = '';
  const query = Object.entries(parms).map(([k, v]) => `${queryItem(k)}=${queryItem(v)}`).join('&');
  const href = u.href;
  return `${href}${u.search ? '&' : href.endsWith('?') ? '' : '?'}${query}${hash}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// --header-font-name and --footer-font-name as Qt 4.8 reads a family
// (qfontdatabase.cpp familyList): names split at the commas, each trimmed
// and taken out of one pair of quotes, then the default family. Each name
// goes in as a CSS string.
export function qtFamilyList(name: string): string[] {
  const unquote = (s: string) => ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s);
  return name.split(',').map((s) => unquote(s.trim())).filter(Boolean);
}

// fallback: the family Qt falls back to when none of the names is a font
// it has (qtFallbackFamily), before CSS's own.
export function fontFamily(name: string, fallback?: string): string {
  const css = (s: string) => `'${s.replace(/[\\'\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}'`;
  const names = qtFamilyList(name);
  if (fallback && !names.some((n) => n.toLowerCase() === fallback.toLowerCase())) names.push(fallback);
  return [...names.map(css), 'sans-serif'].join(', ');
}

export interface TextFonts {
  // @font-face rules: the web fonts of the pages that a text names.
  css: string;
  // By font name (--header-font-name, --footer-font-name): the family Qt
  // falls back to.
  fallbacks: Map<string, string>;
}

// The fonts of the header and footer texts, as Qt 4.8 drew them. Under
// Linux, its font database held the web fonts the pages had loaded, by the
// family names written in their files (WebKit 534 added them to
// fontconfig): a text named after one of them was drawn with it (EDB's
// Signika), whatever the @font-face called it (measured on 0.12.6). The
// text document loads nothing: each such face goes in as data:, read
// without a new request. Under Windows, those fonts were the page's alone.
// A name that matches none falls back as Qt did (qtFallbackFamily).
// pageFontRules runs on each page once printed, before it is closed.
export async function textFonts(fontNames: string[], rules: string[]): Promise<TextFonts> {
  const fallbacks = new Map<string, string>();
  for (const n of new Set(fontNames)) {
    const f = await qtFallbackFamily(qtFamilyList(n));
    if (f) fallbacks.set(n, f);
  }
  return { css: [...new Set(rules)].join('\n'), fallbacks };
}

// The @font-face rules, data: sources, of the faces a page loaded whose
// file names one of the texts' fonts (Linux only).
export async function pageFontRules(lp: LoadedPage, fontNames: string[]): Promise<string[]> {
  if (process.platform !== 'linux' || !fontNames.length) return [];
  const wanted = new Map(fontNames.flatMap(qtFamilyList).map((n) => [n.toLowerCase(), n]));
  const q = (s: string) => `'${s.replace(/[\'\n\r\f]/g, (c) => `\${c.charCodeAt(0).toString(16)} `)}'`;
  // The @font-face rules of the families the page loaded, their sources
  // made absolute.
  const faces = await lp.page.evaluate(() => {
    const out: { style: string; weight: string; stretch: string; urls: string[] }[] = [];
    const plain = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2').toLowerCase();
    const loaded = new Set(Array.from(document.fonts).filter((f) => f.status === 'loaded').map((f) => plain(f.family)));
    const visit = (list: CSSRuleList, base: string) => {
      for (const r of Array.from(list)) {
        if (r instanceof CSSFontFaceRule) {
          if (!loaded.has(plain(r.style.getPropertyValue('font-family')))) continue;
          const urls = Array.from(r.style.getPropertyValue('src').matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g), (m) => {
            try {
              return new URL(m[2]!, base).href;
            } catch {
              return '';
            }
          }).filter(Boolean);
          const d = (p: string, v: string) => r.style.getPropertyValue(p).trim() || v;
          out.push({ style: d('font-style', 'normal'), weight: d('font-weight', 'normal'), stretch: d('font-stretch', 'normal'), urls });
        } else if (r instanceof CSSImportRule) {
          try {
            if (r.styleSheet) visit(r.styleSheet.cssRules, r.styleSheet.href ?? base);
          } catch {
            // Another origin.
          }
        } else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) visit((r as CSSGroupingRule).cssRules, base);
      }
    };
    for (const s of Array.from(document.styleSheets)) {
      try {
        visit(s.cssRules, s.href ?? document.baseURI);
      } catch {
        // Another origin: its rules cannot be read here.
      }
    }
    return out;
  }).catch(() => []);
  const rules: string[] = [];
  for (const f of faces) {
    // The first source that can be had without a request (faceData).
    for (const url of f.urls) {
      const data = await faceData(lp, url);
      if (!data) continue;
      for (const family of sfntFamilies(data)) {
        const name = wanted.get(family.toLowerCase());
        if (name) rules.push(`@font-face { font-family: ${q(name)}; src: url(data:application/octet-stream;base64,${data.toString('base64')}); font-style: ${f.style}; font-weight: ${f.weight}; font-stretch: ${f.stretch} }`);
      }
      break;
    }
  }
  return rules;
}

// A face's bytes, read without a new request: a data: source as it is, a
// file as the page read it, one of the page's own origin from the browser's
// cache only. One of another origin is left out.
async function faceData(lp: LoadedPage, url: string): Promise<Buffer | null> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    const payload = url.slice(comma + 1);
    try {
      return /;base64$/i.test(url.slice(0, comma)) ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'latin1');
    } catch {
      return null;
    }
  }
  if (url.startsWith('file:')) {
    try {
      return readFileSync(fileURLToPath(url));
    } catch {
      return null;
    }
  }
  const b64 = await lp.page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u, { cache: 'only-if-cached', mode: 'same-origin' });
      if (!r.ok) return null;
      const bytes = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    } catch {
      return null;
    }
  }, url).catch(() => null);
  return b64 ? Buffer.from(b64, 'base64') : null;
}

export function hasText(h: HeaderFooter): boolean {
  return h.line || Boolean(h.left || h.center || h.right);
}

// One page per body page with that page's header and footer text. The
// header text sits `spacing` above the content, its line there too; the
// footer text starts `spacing` below the content (endPage).
export function textDocument(g: Geometry, pages: { header: HeaderFooter; footer: HeaderFooter; parms: Parms }[], fonts?: TextFonts): string {
  const cw = g.width - g.left - g.right;
  const box = (h: HeaderFooter, parms: Parms, header: boolean) => {
    const font = `font-family: ${fontFamily(h.fontName, fonts?.fallbacks.get(h.fontName))}; font-size: ${h.fontSize}pt;`;
    const pos = header
      ? `top: calc(${g.top - h.spacing}mm - 1lh)`
      : `bottom: calc(${g.bottom - h.spacing}mm - 1lh)`;
    // Escaped: a quote in the font's name ended the attribute, and the
    // text lost its place, at the top of the page.
    const text = ([['left', h.left], ['center', h.center], ['right', h.right]] as const)
      .filter(([, t]) => t)
      .map(([a, t]) => `<div class="t" style="${attr(`${font} ${pos}; text-align: ${a}`)}">${esc(hfreplace(t, parms))}</div>`)
      .join('');
    const lineY = header ? g.top - h.spacing : g.height - g.bottom + h.spacing;
    const line = h.line ? `<div class="l" style="top: ${lineY}mm"></div>` : '';
    return text + line;
  };
  const body = pages.map((p) => `<div class="p">${box(p.header, p.parms, true)}${box(p.footer, p.parms, false)}</div>`).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    @page { size: ${g.width}mm ${g.height}mm; margin: 0 }
    html, body { margin: 0; padding: 0; background: transparent }
    .p { position: relative; width: ${g.width}mm; height: ${g.height}mm; overflow: hidden; break-after: page }
    .p:last-child { break-after: auto }
    .t { position: absolute; left: ${g.left}mm; width: ${cw}mm; line-height: normal; white-space: pre; color: black }
    .l { position: absolute; left: ${g.left}mm; width: ${cw}mm; height: 0; border-top: 1px solid black }
  ${fonts?.css ?? ''}</style>${body}`;
}

export async function printDocument(context: BrowserContext, html: string, dir: string, g: Geometry, spec: Omit<LoadSpec, 'url' | 'viewport'>, out: Reporter): Promise<Uint8Array> {
  const file = join(mkdtempSync(join(dir, 'hf-')), 'text.html');
  writeFileSync(file, html);
  const lp = await openPage(context, {
    ...spec,
    url: pathToFileURL(file).href,
    viewport: { width: g.width * PX_PER_MM, height: g.height * PX_PER_MM },
    allowFiles: [file],
    load: { ...spec.load, jsdelay: 0, blockLocalFileAccess: true, allowed: [], customHeaders: [], cookies: [] },
    emulation: undefined,
  }, out);
  const pdf = await lp.page.pdf({
    width: `${g.width}mm`, height: `${g.height}mm`, margin: { top: 0, right: 0, bottom: 0, left: 0 },
    printBackground: false, preferCSSPageSize: false, tagged: false, outline: false, timeout: 0,
  });
  await lp.page.close();
  return pdf;
}

export interface Box {
  width: number; // mm, the content width
  scale: number;
  spec: Omit<LoadSpec, 'url' | 'viewport' | 'isMain'>;
}

export interface Measure {
  box: number; // mm, height of the header's <body> box: placed by it
  extent: number; // mm, what to print: the box, or its content if taller
  textBottom: number; // mm, the last line of text, for automatic margins
}

// Lays a header out at the content width and measures it, as
// calculateHeaderHeight does to size an automatic margin. ok: the header
// page loaded.
export async function measure(context: BrowserContext, url: string, b: Box, out: Reporter): Promise<{ m: Measure; errorCode: number; ok: boolean }> {
  const lp = await openPage(context, {
    ...b.spec,
    url,
    isMain: false,
    viewport: { width: (b.width * PX_PER_MM) / b.scale, height: 100 },
  }, out);
  await emulate(lp);
  const px = await lp.page.evaluate(() => {
    const body = document.body;
    if (!body) return { box: 0, extent: 0, textBottom: 0 };
    const rect = body.getBoundingClientRect();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let textBottom = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.height > 0) textBottom = Math.max(textBottom, r.bottom - rect.top);
    }
    // From the top of the document: the body's own margin is printed too.
    const extent = Math.max(rect.bottom, ...Array.from(body.children).map((c) => c.getBoundingClientRect().bottom));
    return { box: rect.height, extent, textBottom };
  }).catch(() => ({ box: 0, extent: 0, textBottom: 0 }));
  await lp.page.close();
  const mm = (v: number) => (v * b.scale) / PX_PER_MM;
  return { m: { box: mm(px.box), extent: mm(px.extent), textBottom: mm(px.textBottom) }, errorCode: lp.errorCode, ok: lp.ok };
}

// All the pages of one header-html: one <iframe> per page, printed once;
// page i of the result is the header of body page i. A header page of the
// web runs in a process of its own in this page, opened from a file, and
// Chromium printed it blank up to 1.3.0: each is printed apart and drawn
// in (src/engine/frames.ts).
export async function renderHtml(context: BrowserContext, urls: string[], b: Box, height: number, dir: string, out: Reporter): Promise<{ pdf: Uint8Array; errorCode: number }> {
  const w = (b.width * PX_PER_MM) / b.scale;
  const h = (Math.max(height, 0.1) * PX_PER_MM) / b.scale;
  const frames = urls.map((u) => `<iframe src="${u.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>`).join('');
  const html = `<!doctype html><style>
    html, body { margin: 0; padding: 0; background: transparent }
    iframe { display: block; border: 0; width: ${w}px; height: ${h}px; break-after: page }
    iframe:last-child { break-after: auto }
  </style>${frames}`;
  const file = join(mkdtempSync(join(dir, 'hf-')), 'headers.html');
  writeFileSync(file, html);
  const lp = await openPage(context, {
    ...b.spec,
    url: pathToFileURL(file).href,
    // The header page's host, not this page's, decides where --cookie goes.
    site: urls[0],
    isMain: false,
    viewport: { width: w, height: h },
    // wkhtmltopdf loads each header page on its own: it may read itself.
    allowFiles: [file, ...new Set(urls.filter((u) => u.startsWith('file:')).map((u) => fileURLToPath(u.split('?')[0]!)))],
  }, out);
  // A header page that does not load, kept by --load-error-handling (abort
  // stopped the conversion at the measure): wkhtmltopdf says so for each
  // page's. Chromium shows its error page in that frame.
  const handling = b.spec.load.loadErrorHandling;
  if (handling !== 'abort') {
    for (const f of lp.page.mainFrame().childFrames()) {
      if (!f.url().startsWith('chrome-error:')) continue;
      const src = await f.frameElement().then((e) => e?.evaluate((el) => el.getAttribute('src'))).catch(() => null);
      if (src) out.warning(`Failed loading page ${src} (${handling === 'skip' ? 'skipped' : 'ignored'})`);
    }
  }
  await emulate(lp);
  const marks = await markFrames(lp);
  let pdf = await lp.page.pdf({
    width: `${b.width}mm`, height: `${Math.max(height, 0.1)}mm`, margin: { top: 0, right: 0, bottom: 0, left: 0 },
    printBackground: true, scale: b.scale, preferCSSPageSize: false, tagged: false, outline: false, timeout: 0,
  });
  if (marks.length) {
    const [{ PDFDocument }, { placeFrames }] = await pdfModules();
    const doc = await PDFDocument.load(pdf, READ);
    const print = printer();
    // This page told already what did not load in its frames.
    const quiet: Reporter = { warning() {}, error() {} };
    await placeFrames(doc, marks, (b.scale * 72) / 96, (m, fw, fh) => print(`${m.url} ${Math.round(fw)} ${Math.round(fh)}`, () => printApart(lp, m, fw, fh, true, quiet)));
    pdf = await doc.save(WRITE);
  }
  await lp.page.close();
  return { pdf, errorCode: lp.errorCode };
}

export interface Placement { left: number; top: number; width: number; height: number } // mm

export interface Layer {
  pdf: Uint8Array; // page i is drawn on body page targets[i]
  targets: number[];
  place: Placement;
}

export async function stamp(doc: PDFDocument, pages: PDFPage[], layers: Layer[]): Promise<void> {
  for (const layer of layers) {
    const src = await (await pdfModules())[0].PDFDocument.load(layer.pdf, READ);
    const n = Math.min(src.getPageCount(), layer.targets.length);
    // A page Chromium left blank has no content stream: nothing to draw.
    const indices = Array.from({ length: n }, (_, i) => i).filter((i) => src.getPage(i).node.normalizedEntries().Contents);
    const embedded = await doc.embedPdf(src, indices);
    const p = layer.place;
    embedded.forEach((e, k) => {
      const page = pages[layer.targets[indices[k]!]!];
      if (!page) return;
      page.drawPage(e, {
        x: p.left * PT_PER_MM,
        y: page.getHeight() - (p.top + p.height) * PT_PER_MM,
        width: p.width * PT_PER_MM,
        height: p.height * PT_PER_MM,
      });
    });
  }
}
