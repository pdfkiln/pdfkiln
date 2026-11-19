// Frames that Chromium leaves blank, loaded again on their own and put back
// where they are:
// - in a PDF, a frame that runs in a process of its own: what Chromium makes
//   of a web frame in a page opened from a file (a path, the standard
//   input), site isolation or not. chrome-headless-shell prints such a frame
//   blank, and a frame's target has no Page.printToPDF (measured, Chromium
//   156 and 158). wkhtmltopdf printed it.
// - in an image beyond the window, a frame of another origin than the page
//   that holds it: Chromium paints it within the window only, in a page
//   opened from a file or loaded from its address (measured, Chromium 158).
// Each is loaded again in a tab of its own, at its size, under the rules of
// the page that holds it: that page's host for --header and --cookie, its
// access to files, its emulations. Then it is printed there and drawn into
// the PDF where a link laid over the frame lands (src/pdf/frames.ts), or
// captured and laid over the frame before the page's own capture. CSS
// anchor positioning lays both, and follows the frame through the print
// layout to its page. A frame whose content depends on the page that holds
// it (messages between the two) may come out otherwise than in the page.
import type { ElementHandle, Frame } from 'puppeteer-core';
import { FileAccess, filePath } from './files.js';
import { emulate, openPage, type LoadedPage, type LoadSpec, type Reporter } from './loader.js';

// The frame's borders and padding, in CSS pixels: its content sits inside.
export interface Inset { top: number; right: number; bottom: number; left: number }

export interface FrameMark {
  // The address of the link laid over the frame, and the frame's own.
  href: string;
  url: string;
  inset: Inset;
}

const MARK = 'https://pdfkiln.invalid/frame/';

// Puppeteer gives a frame of another process a DevTools session of its own.
const clientOf = (f: Frame): unknown => (f as unknown as { client?: unknown }).client;

// What a frame loaded apart may be: a web page, or data: written in the page.
const APART = /^(https?|data):/i;

// Runs in the page that holds the frame: an element laid over it by CSS
// anchor positioning, absolutely positioned, which no rule of the page
// reaches (all: initial), nor shows the address of a link after it, as
// print style sheets do (Bootstrap's a[href]::after); it goes when the
// frame is not shown (position-visibility). A link to find in the PDF, or
// an image, once decoded. False when the frame has no box.
async function layOver(e: Element, tag: string, n: number, place: string, value: string): Promise<boolean> {
  if (!e.getClientRects().length) return false;
  const doc = e.ownerDocument;
  const name = `--pdfkiln-frame-${n}`;
  (e as HTMLElement).style.setProperty('anchor-name', name, 'important');
  const o = doc.createElement(tag);
  o.id = `pdfkiln-frame-${n}`;
  o.setAttribute('aria-hidden', 'true');
  o.style.cssText = `all: initial !important; display: block !important; position: absolute !important; position-anchor: ${name} !important; position-visibility: anchors-visible !important; ${place}`;
  const style = doc.createElement('style');
  style.textContent = `#pdfkiln-frame-${n}::before, #pdfkiln-frame-${n}::after { content: none !important; display: none !important; }`;
  (doc.body ?? doc.documentElement).append(o, style);
  if (o instanceof HTMLAnchorElement) o.href = value;
  if (o instanceof HTMLImageElement) {
    o.alt = '';
    o.src = value;
    await o.decode().catch(() => {});
  }
  return true;
}

// The frame's insets and content box, read in the page that holds it.
async function boxOf(el: ElementHandle<Element>): Promise<{ inset: Inset; width: number; height: number; within: boolean } | null> {
  return el.evaluate((e) => {
    if (!e.getClientRects().length) return null;
    const cs = getComputedStyle(e);
    const px = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0;
    const r = e.getBoundingClientRect();
    return {
      inset: {
        top: px('border-top-width') + px('padding-top'),
        right: px('border-right-width') + px('padding-right'),
        bottom: px('border-bottom-width') + px('padding-bottom'),
        left: px('border-left-width') + px('padding-left'),
      },
      width: (e as HTMLElement).clientWidth - px('padding-left') - px('padding-right'),
      height: (e as HTMLElement).clientHeight - px('padding-top') - px('padding-bottom'),
      within: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    };
  }).catch(() => null);
}

// Whether the page that holds a frame may load it: a file by that page's
// rules, not the frame's, which would allow the frame's own file.
function mayLoad(spec: LoadSpec, url: string, native: boolean): boolean {
  if (!/^file:/i.test(url)) return APART.test(url);
  const path = filePath(url.split('#')[0]!);
  if (!path) return false;
  const access = new FileAccess(spec.load.blockLocalFileAccess, native);
  for (const a of spec.load.allowed) access.allow(a);
  for (const a of spec.allowFiles ?? []) access.allow(a);
  const own = spec.url.startsWith('file:') ? filePath(spec.url) : null;
  if (own) access.allow(own);
  return access.allows(path);
}

// A frame's address, opened in a tab of its own under the rules of the page
// that holds it. --custom-header without propagation and --post go with the
// page's own request only, not the frame's.
function openApart(lp: LoadedPage, url: string, viewport: LoadSpec['viewport'], out: Reporter): Promise<LoadedPage> {
  const s = lp.spec;
  return openPage(lp.page.browserContext(), {
    ...s,
    url,
    isMain: false,
    viewport,
    site: s.site ?? s.url,
    load: { ...s.load, post: [], customHeaders: s.load.repeatCustomHeaders ? s.load.customHeaders : [] },
    css: undefined,
    waitFor: undefined,
  }, out);
}

// Before printing: a link laid over each frame Chromium will print blank,
// one in a process of its own whose parent prints, the page's own frame or
// one of its process.
export async function markFrames(lp: LoadedPage): Promise<FrameMark[]> {
  const main = clientOf(lp.page.mainFrame());
  if (main === undefined) return [];
  const marks: FrameMark[] = [];
  for (const f of lp.page.frames()) {
    const parent = f.parentFrame();
    if (!parent || !APART.test(f.url()) || clientOf(f) === clientOf(parent) || clientOf(parent) !== main) continue;
    const el = await f.frameElement().catch(() => null);
    const box = el && await boxOf(el);
    if (!el || !box) continue;
    const href = `${MARK}${marks.length}`;
    const place = 'top: anchor(top) !important; left: anchor(left) !important; width: anchor-size(width) !important; height: anchor-size(height) !important;';
    if (await el.evaluate(layOver, 'a', marks.length, place, href).catch(() => false)) marks.push({ href, url: f.url(), inset: box.inset });
  }
  return marks;
}

// A frame printed apart, on a page of its content's size in CSS pixels, as
// the page that holds it prints: its emulations, print media. Null when it
// does not load.
export async function printApart(lp: LoadedPage, url: string, width: number, height: number, background: boolean, out: Reporter): Promise<Uint8Array | null> {
  if (!mayLoad(lp.spec, url, Boolean(out.failed))) return null;
  const apart = await openApart(lp, url, { width, height }, out);
  try {
    if (!apart.ok) return null;
    await emulate(apart);
    await apart.cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    return await apart.page.pdf({
      width: `${width}px`,
      height: `${height}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: background,
      pageRanges: '1',
      preferCSSPageSize: false,
      timeout: 0,
    });
  } finally {
    await apart.page.close().catch(() => {});
  }
}

// Before an image's capture beyond the window: each frame of another origin
// than the frame that holds it, which is painted (the page's, or one of its
// origin), captured apart at its size and laid over it. Of the page's own
// frames, those wholly within the window are painted already. A sandboxed
// frame is left: apart, its scripts would run.
export async function paintFrames(lp: LoadedPage, scale: number, out: Reporter): Promise<void> {
  const main = lp.page.mainFrame();
  const foreign = new Map<Frame, ElementHandle<Element>>();
  for (const f of lp.page.frames()) {
    if (!f.parentFrame() || f.url() === '') continue;
    const el = await f.frameElement().catch(() => null);
    if (!el) continue;
    // Of another origin: no document that the parent may read.
    const other = await el.evaluate((e) => (e as HTMLIFrameElement).contentDocument === null && !e.hasAttribute('sandbox')).catch(() => false);
    if (other) foreign.set(f, el);
  }
  // Frames come parents first.
  const painted = new Set<Frame>([main]);
  for (const f of lp.page.frames()) {
    const parent = f.parentFrame();
    if (parent && painted.has(parent) && !foreign.has(f)) painted.add(f);
  }
  let n = 0;
  for (const [f, el] of foreign) {
    const parent = f.parentFrame()!;
    if (!painted.has(parent) || !mayLoad(lp.spec, f.url(), Boolean(out.failed))) continue;
    const box = await boxOf(el);
    if (!box || box.width < 1 || box.height < 1 || (parent === main && box.within)) continue;
    const apart = await openApart(lp, f.url(), { width: Math.round(box.width), height: Math.round(box.height), scale }, out);
    let png: string | undefined;
    try {
      // What the frame does not paint shows the page behind it.
      if (apart.ok) {
        await apart.cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
        png = (await apart.cdp.send('Page.captureScreenshot', { format: 'png' })).data;
      }
    } finally {
      await apart.page.close().catch(() => {});
    }
    if (!png) continue;
    const place = `top: calc(anchor(top) + ${box.inset.top}px) !important; left: calc(anchor(left) + ${box.inset.left}px) !important; width: ${box.width}px !important; height: ${box.height}px !important;`;
    await el.evaluate(layOver, 'img', n++, place, `data:image/png;base64,${png}`).catch(() => false);
  }
}
