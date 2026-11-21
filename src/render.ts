// Prototype renderer: one HTML page to PDF through Chromium's
// Page.printToPDF, with the defaults of wkhtmltopdf 0.12.6 instead of
// Chromium's. Only what the measurements need; not the v1 interface.
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type CDPSession, type Page } from 'puppeteer-core';
import { executablePath } from './chromium.js';
import type { GenericFamilies } from './engine/fonts.js';
import { documentFrames } from './engine/loader.js';
import { applyMediaWidth, roundFontSizes } from './wkemulation.js';

export interface Margins { top: number; right: number; bottom: number; left: number }

// Defaults of wkhtmltopdf 0.12.6 (src/lib/pdfsettings.cc, loadsettings.cc,
// websettings.cc, pdfconverter.cc). Lengths in millimetres.
export const WKHTMLTOPDF_DEFAULTS = {
  pageWidth: 210, // A4
  pageHeight: 297,
  // Left and right are 10 mm; top and bottom are -1 ("unset") and become
  // 10 mm when there is no header-html or footer-html to measure.
  margin: { top: 10, right: 10, bottom: 10, left: 10 } as Margins,
  javascriptDelay: 200, // ms after the load event
  printMediaType: false, // screen media
  background: true,
} as const;

export interface RenderOptions {
  // Scale passed to printToPDF; 1 is Chromium's natural size.
  scale?: number;
  pageWidth?: number;
  pageHeight?: number;
  margin?: Partial<Margins>;
  javascriptDelay?: number;
  printMediaType?: boolean;
  background?: boolean;
  // Page.printToPDF generateDocumentOutline / generateTaggedPDF.
  outline?: boolean;
  tagged?: boolean;
  // Drop the collapsed top margin at the start of the document, as
  // wkhtmltopdf's WebKit does at the top of the first page.
  truncateTopMargin?: boolean;
  // The generic families' fonts (serif, monospace...), wkhtmltopdf's.
  fontFamilies?: GenericFamilies;
  // Evaluate width and height media queries against this viewport, as
  // wkhtmltopdf does ([0, 0] without --viewport-size).
  mediaViewport?: [number, number];
  // Round font sizes to whole pixels, as Qt does.
  roundFontSizes?: boolean;
}

export interface Timings { [step: string]: number }

export async function launch(env: NodeJS.ProcessEnv = {}): Promise<Browser> {
  const exe = executablePath();
  if (!existsSync(exe)) throw new Error(`${exe} is missing: run npm run fetch:chromium`);
  // Pipe transport: no DevTools port is opened. The sandbox stays on.
  return puppeteer.launch({ executablePath: exe, headless: 'shell', pipe: true, env: { ...process.env, ...env } });
}

export function toUrl(input: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:\\/i.test(input)
    ? input
    : pathToFileURL(resolve(input)).href;
}

const mm = (v: number) => `${v}mm`;

// One DevTools session per page carries every override: once a second
// session is attached, Chromium ignores the media emulation set through
// Puppeteer's own session.
const sessions = new WeakMap<Page, Promise<CDPSession>>();
export function session(page: Page): Promise<CDPSession> {
  let s = sessions.get(page);
  if (!s) {
    s = page.createCDPSession();
    sessions.set(page, s);
  }
  return s;
}

export async function emulateMedia(page: Page, media: 'screen' | 'print'): Promise<void> {
  await (await session(page)).send('Emulation.setEmulatedMedia', { media });
}

// WebKit loads web fonts from any origin; Chromium applies CORS to them, so
// a page opened from a file (origin "null") loses the fonts of its server.
// The CORS check runs before response interception, so font requests are
// fetched here and fulfilled with Access-Control-Allow-Origin added, the way
// the network relay of the specification would.
const fontCorsPages = new WeakSet<Page>();
export async function allowCrossOriginFonts(page: Page): Promise<void> {
  if (fontCorsPages.has(page)) return;
  fontCorsPages.add(page);
  const cdp = await session(page);
  cdp.on('Fetch.requestPaused', async (e: { requestId: string; request: { url: string; method: string } }) => {
    try {
      const r = await fetch(e.request.url);
      const body = Buffer.from(await r.arrayBuffer()).toString('base64');
      const responseHeaders = [...r.headers]
        .filter(([k]) => k !== 'access-control-allow-origin' && k !== 'content-encoding')
        .map(([name, value]) => ({ name, value }));
      responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      await cdp.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: r.status, responseHeaders, body });
    } catch {
      await cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
    }
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http*', resourceType: 'Font', requestStage: 'Request' }] });
}

// Runs in the page. When the body's top margin collapses with the margins of
// its first descendants, the body's border box starts that far below the root;
// WebKit drops that space on the first page, so pull the document up by it.
function truncateTopMargin(): number {
  const root = document.documentElement;
  const body = document.body;
  if (!body) return 0;
  const style = getComputedStyle(root);
  const rootTop = root.getBoundingClientRect().top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
  const gap = body.getBoundingClientRect().top - rootTop;
  if (gap > 0) root.style.setProperty('margin-top', `${-gap}px`, 'important');
  return gap;
}

// Sets the emulations of `opts` that must precede navigation, and returns
// the ones to run once the page and its frames are loaded.
export async function emulate(page: Page, opts: RenderOptions): Promise<() => Promise<void>> {
  const cdp = await session(page);
  if (opts.fontFamilies) await cdp.send('Page.setFontFamilies', { fontFamilies: opts.fontFamilies });
  return async () => {
    if (opts.mediaViewport) await applyMediaWidth(cdp, ...opts.mediaViewport);
    await Promise.all(documentFrames(page).map(async (frame) => {
      if (opts.roundFontSizes) await frame.evaluate(roundFontSizes);
      if (opts.truncateTopMargin) await frame.evaluate(truncateTopMargin);
    }));
  };
}

// Loads `url` in `page` and prints it. The page is left open.
export async function printPage(page: Page, url: string, opts: RenderOptions = {}, t: Timings = {}): Promise<Uint8Array> {
  const d = WKHTMLTOPDF_DEFAULTS;
  let t0 = performance.now();
  await allowCrossOriginFonts(page);
  await emulateMedia(page, (opts.printMediaType ?? d.printMediaType) ? 'print' : 'screen');
  const loaded = await emulate(page, opts);
  await page.goto(url, { waitUntil: 'load' });
  t.load = performance.now() - t0;
  await loaded();

  t0 = performance.now();
  const delay = opts.javascriptDelay ?? d.javascriptDelay;
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  t.delay = performance.now() - t0;

  t0 = performance.now();
  const margin = { ...d.margin, ...opts.margin };
  const pdf = await page.pdf({
    width: mm(opts.pageWidth ?? d.pageWidth),
    height: mm(opts.pageHeight ?? d.pageHeight),
    margin: { top: mm(margin.top), right: mm(margin.right), bottom: mm(margin.bottom), left: mm(margin.left) },
    printBackground: opts.background ?? d.background,
    scale: opts.scale ?? 1,
    preferCSSPageSize: false, // wkhtmltopdf ignores @page size
    outline: opts.outline ?? false,
    tagged: opts.tagged ?? false,
  });
  t.print = performance.now() - t0;
  return pdf;
}

// Full call, as the command will do it: start Chromium, print, stop it.
export async function renderFile(input: string, output: string, opts: RenderOptions = {}): Promise<Timings> {
  const t: Timings = {};
  let t0 = performance.now();
  const browser = await launch();
  t.launch = performance.now() - t0;
  try {
    t0 = performance.now();
    const page = await browser.newPage();
    t.newPage = performance.now() - t0;
    const pdf = await printPage(page, toUrl(input), opts, t);
    t0 = performance.now();
    await writeFile(output, pdf);
    t.write = performance.now() - t0;
  } finally {
    t0 = performance.now();
    await browser.close();
    t.close = performance.now() - t0;
  }
  return t;
}
