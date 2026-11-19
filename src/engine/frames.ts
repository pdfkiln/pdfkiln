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
// Each is loaded again in a tab of its own, from the address its element
// gives, at its size, under the rules of the page that holds it: that
// page's host for --header and --cookie, its access to files, its
// emulations. Then it is printed there and drawn into the PDF where a link
// laid over the frame lands (src/pdf/frames.ts), or captured and laid over
// the frame before the page's own capture. CSS anchor positioning lays both,
// and follows the frame through the print layout to its page.
// Left as Chromium leaves them: a frame that is sandboxed (apart, its
// scripts would run), hidden or transparent, under a transform (anchor
// positioning does not follow it), or cut by an ancestor (put back whole,
// it would cover its neighbours); and one that fails to load or to print. A
// frame whose content depends on the page that holds it (messages between
// the two) may come out otherwise.
import type { ElementHandle, Frame } from 'puppeteer-core';
import { FileAccess, filePath } from './files.js';
import { emulate, openPage, type LoadedPage, type LoadSpec, type Reporter } from './loader.js';

// The frame's borders and padding, in CSS pixels: its content sits inside.
export interface Inset { top: number; right: number; bottom: number; left: number }

export interface FrameMark {
  // The address of the link laid over the frame; the frame's address and
  // the Referer the page would send it.
  href: string;
  url: string;
  referer?: string;
  inset: Inset;
}

const MARK = 'https://pdfkiln.invalid/frame/';
// A link of 100 CSS pixels laid in the page with the others: its rectangle
// gives the print's scale, Chromium's shrinking of a page wider than the
// paper included.
export const SCALE_MARK = `${MARK}scale`;
// Frames loaded apart at a time.
const AT_ONCE = 4;

// Puppeteer gives a frame of another process a DevTools session of its own.
const clientOf = (f: Frame): unknown => (f as unknown as { client?: unknown }).client;

// What a frame loaded apart may be: a web page, or data: written in the page.
const APART = /^(https?|data):/i;

interface Box {
  url: string;
  referer?: string;
  inset: Inset;
  width: number;
  height: number;
  within: boolean;
}

// Runs in the page that holds the frame: its address, the Referer the page
// would send it, its insets and content box; null for a frame left as
// Chromium leaves it (see above).
function measure(e: Element): Box | null {
  const f = e as HTMLIFrameElement;
  if (!f.getClientRects().length || f.hasAttribute('sandbox')) return null;
  if (!f.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true } as CheckVisibilityOptions)) return null;
  const r = f.getBoundingClientRect();
  const body = f.ownerDocument.body;
  for (let a: Element | null = f.parentElement ?? ((f.getRootNode() as ShadowRoot).host ?? null); a; a = a.parentElement ?? ((a.getRootNode() as ShadowRoot).host ?? null)) {
    const s = getComputedStyle(a);
    if (s.transform !== 'none' || s.translate !== 'none' || s.rotate !== 'none' || s.scale !== 'none') return null;
    if (a === body || a === f.ownerDocument.documentElement) continue;
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible' || s.clipPath !== 'none') {
      const c = a.getBoundingClientRect();
      if (r.left < c.left - 0.5 || r.top < c.top - 0.5 || r.right > c.right + 0.5 || r.bottom > c.bottom + 0.5) return null;
    }
  }
  const cs = getComputedStyle(f);
  const px = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0;
  // The Referer of a frame's request: none from a file, nor under a policy
  // that withholds it, nor from https to http; the page's origin otherwise,
  // as Chromium sends it to another origin.
  const page = new URL(f.ownerDocument.URL);
  const policy = (f.referrerPolicy || f.ownerDocument.querySelector<HTMLMetaElement>('meta[name="referrer" i]')?.content || '').toLowerCase();
  const target = /^https?:/i.test(f.src) ? new URL(f.src) : null;
  const withheld = policy === 'no-referrer' || policy === 'same-origin' || (page.protocol === 'https:' && target?.protocol === 'http:' && policy !== 'unsafe-url' && policy !== 'no-referrer-when-downgrade');
  return {
    url: f.src,
    referer: /^https?:$/.test(page.protocol) && target && !withheld ? `${page.origin}/` : undefined,
    inset: {
      top: px('border-top-width') + px('padding-top'),
      right: px('border-right-width') + px('padding-right'),
      bottom: px('border-bottom-width') + px('padding-bottom'),
      left: px('border-left-width') + px('padding-left'),
    },
    width: f.clientWidth - px('padding-left') - px('padding-right'),
    height: f.clientHeight - px('padding-top') - px('padding-bottom'),
    within: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
  };
}

// Runs in the page that holds the frame: an element laid over it by CSS
// anchor positioning, in the frame's own tree (a shadow root's anchor names
// are its own), absolutely positioned, which no rule of the page reaches
// (all: initial), nor shows the address of a link after it, as print style
// sheets do (Bootstrap's a[href]::after), by a style sheet of its own that
// the page's Content-Security-Policy does not stop; it goes when the frame
// is not shown (position-visibility). A link to find in the PDF, or a
// canvas painted with the frame's capture, which no img-src stops. Laid
// elsewhere than over the frame, it is taken out: false.
async function layOver(e: Element, tag: string, n: number, place: string, value: string, inset: number[]): Promise<boolean> {
  const doc = e.ownerDocument;
  const root = e.getRootNode() as Document | ShadowRoot;
  const name = `--pdfkiln-frame-${n}`;
  (e as HTMLElement).style.setProperty('anchor-name', name, 'important');
  const o = doc.createElement(tag);
  o.id = `pdfkiln-frame-${n}`;
  o.setAttribute('aria-hidden', 'true');
  o.style.cssText = `all: initial !important; display: block !important; position: absolute !important; position-anchor: ${name} !important; position-visibility: anchors-visible !important; ${place}`;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`#pdfkiln-frame-${n}::before, #pdfkiln-frame-${n}::after { content: none !important; display: none !important; }`);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  if (o instanceof HTMLAnchorElement) o.href = value;
  if (o instanceof HTMLCanvasElement) {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    const picture = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    o.width = picture.width;
    o.height = picture.height;
    o.getContext('2d')?.drawImage(picture, 0, 0);
  }
  (root instanceof ShadowRoot ? root : doc.body ?? doc.documentElement).append(o);
  const want = e.getBoundingClientRect();
  const got = o.getBoundingClientRect();
  const [top, right, bottom, left] = inset as [number, number, number, number];
  if (Math.abs(got.left - want.left - left) > 1 || Math.abs(got.top - want.top - top) > 1
    || Math.abs(got.width - (want.width - left - right)) > 1 || Math.abs(got.height - (want.height - top - bottom)) > 1) {
    o.remove();
    return false;
  }
  return true;
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
function openApart(lp: LoadedPage, url: string, referer: string | undefined, viewport: LoadSpec['viewport'], out: Reporter): Promise<LoadedPage> {
  const s = lp.spec;
  return openPage(lp.page.browserContext(), {
    ...s,
    url,
    referer,
    isMain: false,
    viewport,
    site: s.site ?? s.url,
    load: { ...s.load, post: [], customHeaders: s.load.repeatCustomHeaders ? s.load.customHeaders : [] },
    css: undefined,
    waitFor: undefined,
  }, out);
}

// At most AT_ONCE at a time, the same frame at the same size once.
function pool<T>(): (key: string, job: () => Promise<T | null>) => Promise<T | null> {
  const done = new Map<string, Promise<T | null>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  return (key, job) => {
    let p = done.get(key);
    if (!p) {
      p = (async () => {
        if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
        running++;
        try {
          return await job();
        } catch {
          return null;
        } finally {
          running--;
          waiting.shift()?.();
        }
      })();
      done.set(key, p);
    }
    return p;
  };
}

// Before printing: a link laid over each frame Chromium will print blank,
// whose parent prints, the page's own frame or one of its process: one in a
// process of its own, and one of the web that waits to be scrolled to
// (loading=lazy) in a page opened from a file, which printing loads in a
// process of its own, or not at all; and the link that measures the print's
// scale. A deferred frame is not loaded in the page: it is loaded apart.
export async function markFrames(lp: LoadedPage): Promise<FrameMark[]> {
  const main = clientOf(lp.page.mainFrame());
  if (main === undefined) return [];
  const marks: FrameMark[] = [];
  for (const f of lp.page.frames()) {
    const parent = f.parentFrame();
    // Not a frame that failed to load: Chromium's error page.
    if (!parent || clientOf(parent) !== main || f.url().startsWith('chrome-error:')) continue;
    // A deferred frame has no document yet, and its URL is empty.
    const deferred = clientOf(f) === clientOf(parent);
    if (deferred && (f.url() !== '' || !parent.url().startsWith('file:'))) continue;
    try {
      const el = await f.frameElement();
      const box = el && await el.evaluate(measure);
      if (!el || !box || !APART.test(box.url)) continue;
      if (deferred && !(/^https?:/i.test(box.url) && await el.evaluate((e) => (e as HTMLIFrameElement).loading === 'lazy'))) continue;
      const href = `${MARK}${marks.length}`;
      const place = 'top: anchor(top) !important; left: anchor(left) !important; width: anchor-size(width) !important; height: anchor-size(height) !important;';
      if (await el.evaluate(layOver, 'a', marks.length, place, href, [0, 0, 0, 0])) marks.push({ href, url: box.url, referer: box.referer, inset: box.inset });
    } catch {
      // Left as Chromium leaves it.
    }
  }
  if (marks.length) {
    await lp.page.evaluate((href: string) => {
      const a = document.createElement('a');
      a.href = href;
      a.id = 'pdfkiln-frame-scale';
      a.setAttribute('aria-hidden', 'true');
      a.style.cssText = 'all: initial !important; display: block !important; position: absolute !important; top: 0 !important; left: 0 !important; width: 100px !important; height: 100px !important;';
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('#pdfkiln-frame-scale::before, #pdfkiln-frame-scale::after { content: none !important; display: none !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      (document.body ?? document.documentElement).append(a);
    }, SCALE_MARK).catch(() => {});
  }
  return marks;
}

// The frames loaded apart for one page, at most AT_ONCE at a time.
export function printer(): (key: string, job: () => Promise<Uint8Array | null>) => Promise<Uint8Array | null> {
  return pool<Uint8Array>();
}

// A frame printed apart, on a page of its content's size in CSS pixels, as
// the page that holds it prints: its emulations, print media. Null when it
// does not load.
export async function printApart(lp: LoadedPage, mark: FrameMark, width: number, height: number, background: boolean, out: Reporter): Promise<Uint8Array | null> {
  if (!mayLoad(lp.spec, mark.url, Boolean(out.failed))) return null;
  const apart = await openApart(lp, mark.url, mark.referer, { width, height }, out);
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
      tagged: false,
      timeout: 0,
    });
  } finally {
    await apart.page.close().catch(() => {});
  }
}

// Before an image's capture beyond the window: each frame of another origin
// than the frame that holds it, which is painted (the page's, or one of its
// origin), captured apart at its size and laid over it. Of the page's own
// frames, those wholly within the window are painted already.
export async function paintFrames(lp: LoadedPage, scale: number, out: Reporter): Promise<void> {
  const main = lp.page.mainFrame();
  // Of another origin: no document that the parent may read. Frames come
  // parents first.
  const foreign = new Map<Frame, ElementHandle<Element>>();
  const painted = new Set<Frame>([main]);
  for (const f of lp.page.frames()) {
    const parent = f.parentFrame();
    if (!parent || f.url() === '') continue;
    const el = await f.frameElement().catch(() => null);
    if (!el) continue;
    if (await el.evaluate((e) => (e as HTMLIFrameElement).contentDocument === null).catch(() => false)) foreign.set(f, el);
    else if (painted.has(parent)) painted.add(f);
  }
  const capture = pool<string>();
  const jobs: Promise<void>[] = [];
  let n = 0;
  for (const [f, el] of foreign) {
    const parent = f.parentFrame()!;
    if (!painted.has(parent)) continue;
    const box = await el.evaluate(measure).catch(() => null);
    if (!box || box.width < 1 || box.height < 1 || (parent === main && box.within) || !mayLoad(lp.spec, box.url, Boolean(out.failed))) continue;
    const [width, height] = [Math.round(box.width), Math.round(box.height)];
    const k = n++;
    jobs.push((async () => {
      const png = await capture(`${box.url} ${width} ${height}`, async () => {
        const apart = await openApart(lp, box.url, box.referer, { width, height, scale }, out);
        try {
          if (!apart.ok) return null;
          // What the frame does not paint shows the page behind it.
          await apart.cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
          return (await apart.cdp.send('Page.captureScreenshot', { format: 'png' })).data;
        } finally {
          await apart.page.close().catch(() => {});
        }
      });
      if (!png) return;
      const i = box.inset;
      const place = `top: calc(anchor(top) + ${i.top}px) !important; left: calc(anchor(left) + ${i.left}px) !important; width: ${box.width}px !important; height: ${box.height}px !important;`;
      await el.evaluate(layOver, 'canvas', k, place, png, [i.top, i.right, i.bottom, i.left]).catch(() => false);
    })());
  }
  await Promise.all(jobs);
}
