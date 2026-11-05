// Headers and footers of the compatible mode, drawn after the body is
// printed (src/lib/pdfconverter.cc endPage, loadHeaders):
// - header-left/center/right and their footer-* twins, with the variables
//   replaced, are laid out in one HTML document, one page per body page;
// - header-html and footer-html are loaded with wkhtmltopdf's URL
//   parameters, one <iframe> per page in one document printed at once.
// Each result is stamped on the body page.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PDFDocument, PDFPage } from '@cantoo/pdf-lib';
import type { BrowserContext } from 'puppeteer-core';
import { emulate, openPage, type LoadSpec, type Reporter } from '../engine/loader.js';
import { pdfModules } from '../pdf/modules.js';
import type { HeaderFooter } from './settings.js';

const PT_PER_MM = 72 / 25.4;
const PX_PER_MM = 96 / 25.4;

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

// The query of a header-html URL. wkhtmltopdf encodes spaces as %20.
export function withParms(url: string, parms: Parms): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(parms)) u.searchParams.append(k, v);
  return u.href.replace(/\+/g, '%20');
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function hasText(h: HeaderFooter): boolean {
  return h.line || Boolean(h.left || h.center || h.right);
}

// One page per body page with that page's header and footer text. The
// header text sits `spacing` above the content, its line there too; the
// footer text starts `spacing` below the content (endPage).
export function textDocument(g: Geometry, pages: { header: HeaderFooter; footer: HeaderFooter; parms: Parms }[]): string {
  const cw = g.width - g.left - g.right;
  const box = (h: HeaderFooter, parms: Parms, header: boolean) => {
    const font = `font-family: '${h.fontName.replace(/'/g, "\\'")}', sans-serif; font-size: ${h.fontSize}pt;`;
    const pos = header
      ? `top: calc(${g.top - h.spacing}mm - 1lh)`
      : `bottom: calc(${g.bottom - h.spacing}mm - 1lh)`;
    const text = ([['left', h.left], ['center', h.center], ['right', h.right]] as const)
      .filter(([, t]) => t)
      .map(([a, t]) => `<div class="t" style="${font} ${pos}; text-align: ${a}">${esc(hfreplace(t, parms))}</div>`)
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
  </style>${body}`;
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
    printBackground: false, preferCSSPageSize: false, tagged: false, outline: false,
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
// calculateHeaderHeight does to size an automatic margin.
export async function measure(context: BrowserContext, url: string, b: Box, out: Reporter): Promise<{ m: Measure; errorCode: number }> {
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
  return { m: { box: mm(px.box), extent: mm(px.extent), textBottom: mm(px.textBottom) }, errorCode: lp.errorCode };
}

// All the pages of one header-html: one <iframe> per page, printed once;
// page i of the result is the header of body page i.
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
    isMain: false,
    viewport: { width: w, height: h },
    // wkhtmltopdf loads each header page on its own: it may read itself.
    allowFiles: [file, ...new Set(urls.filter((u) => u.startsWith('file:')).map((u) => fileURLToPath(u.split('?')[0]!)))],
  }, out);
  await emulate(lp);
  const pdf = await lp.page.pdf({
    width: `${b.width}mm`, height: `${Math.max(height, 0.1)}mm`, margin: { top: 0, right: 0, bottom: 0, left: 0 },
    printBackground: true, scale: b.scale, preferCSSPageSize: false, tagged: false, outline: false,
  });
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
    const src = await (await pdfModules())[0].PDFDocument.load(layer.pdf);
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
