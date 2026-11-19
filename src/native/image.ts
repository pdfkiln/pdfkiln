// The native interface's images: the page captured by Chromium in PNG, WebP
// or JPEG, where a PDF does not fit (the preview of a shared link, a
// thumbnail, a picture in an email):
// - the format from --to, or from the output's name (.png, .webp, .jpg,
//   .jpeg);
// - a window of --width x --height CSS pixels, 1280 x 720 by default; the
//   whole page without --height, the window alone with it, one element with
//   --element, wherever it is;
// - --scale: device pixels per CSS pixel, 2 for screens of high density;
// - --quality for JPEG (90 by default) and WebP (lossless by default: for
//   text and flat colours, smaller than a lossy one, 2.6 KB against 11.7 KB
//   at quality 80 for a page of 1280 x 3982 px, measured with Chromium 158);
// - --transparent: no white behind a page that paints no background.
import { extname } from 'node:path';
import type { CDPSession, ElementHandle, Page } from 'puppeteer-core';
import { paintFrames } from '../engine/frames.js';
import { documentFrames, type LoadedPage, type Reporter } from '../engine/loader.js';

export type ImageFormat = 'png' | 'webp' | 'jpeg';

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;
export const DEFAULT_JPEG_QUALITY = 90;

const BY_EXTENSION: Record<string, ImageFormat> = { '.png': 'png', '.webp': 'webp', '.jpg': 'jpeg', '.jpeg': 'jpeg' };

// The image an output's name asks for; null for a PDF: any other name, and
// the standard output.
export function imageFormatOf(output: string): ImageFormat | null {
  return output === '-' ? null : BY_EXTENSION[extname(output).toLowerCase()] ?? null;
}

// The format --to asks for: an image, null for pdf, undefined for a value
// it does not take.
export function formatOfTo(to: string): ImageFormat | null | undefined {
  const t = to.toLowerCase();
  if (t === 'pdf') return null;
  if (t === 'jpg') return 'jpeg';
  return t === 'png' || t === 'webp' || t === 'jpeg' ? t : undefined;
}

// The longest side each format takes: WebP's limit, 16383 px, past which
// Chromium answers "Unable to encode screenshot", and JPEG's, 65535 px.
const LONGEST: Partial<Record<ImageFormat, number>> = { webp: 16383, jpeg: 65535 };
const NAMES: Record<ImageFormat, string> = { png: 'PNG', webp: 'WebP', jpeg: 'JPEG' };

export interface Capture {
  format: ImageFormat;
  // JPEG and WebP; without it, 90 for JPEG and lossless WebP.
  quality?: number;
  transparent: boolean;
  scale: number;
  // --height: the window alone, not the whole page.
  window: boolean;
  element?: string;
}

// What keeps the image from being written, in the user's words.
export class CaptureError extends Error {}

// out: what the frames loaded apart report (src/engine/frames.ts).
export async function capture(lp: LoadedPage, c: Capture, out: Reporter): Promise<Buffer> {
  const { page, cdp } = lp;
  const beyond = !c.window || c.element !== undefined;
  if (beyond) {
    await loadDeferred(page);
    // The frames of another origin, which Chromium paints within the
    // window only: captured apart and laid over.
    await paintFrames(lp, c.scale, out);
  }
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (c.element !== undefined) {
    const box = await page.evaluate((selector: string) => {
      let e: Element | null;
      try {
        e = document.querySelector(selector);
      } catch {
        return 'invalid';
      }
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    }, c.element);
    if (box === 'invalid') throw new CaptureError(`--element takes a CSS selector, not ${c.element}`);
    if (!box) throw new CaptureError(`no element matches ${c.element} (--element)`);
    if (box.width < 1 || box.height < 1) throw new CaptureError(`the first element matching ${c.element} (--element) has no size`);
    clip = { ...box, scale: 1 };
  }
  // The image's size, in pixels, against what the format takes.
  const m = await cdp.send('Page.getLayoutMetrics');
  const [w, h] = clip
    ? [clip.width, clip.height]
    : c.window ? [m.cssLayoutViewport.clientWidth, m.cssLayoutViewport.clientHeight] : [m.cssContentSize.width, m.cssContentSize.height];
  const [pw, ph] = [Math.round(w * c.scale), Math.round(h * c.scale)];
  const longest = LONGEST[c.format];
  if (longest && Math.max(pw, ph) > longest) {
    throw new CaptureError(`the image would be ${pw} x ${ph} px, more than ${NAMES[c.format]} takes (${longest} px a side): --height, --element, or PNG`);
  }
  if (c.transparent) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  let data: string;
  try {
    ({ data } = await cdp.send('Page.captureScreenshot', {
      format: c.format,
      ...(c.format === 'png' ? {} : { quality: c.quality ?? (c.format === 'jpeg' ? DEFAULT_JPEG_QUALITY : 100) }),
      ...(clip ? { clip } : {}),
      captureBeyondViewport: beyond,
    }));
  } catch (e) {
    // Its reason: "Page is too large." for a page of 1280 x 200000 px, for
    // instance (Chromium 158).
    throw new CaptureError(`Chromium could not capture the image of ${pw} x ${ph} px: ${(e as Error).message.replace(/^Protocol error \([^)]*\): /, '')}`);
  }
  return Buffer.from(data, 'base64');
}

// The images and frames that wait to be scrolled to (loading=lazy), in every
// frame: the capture shows what the window does not, so they load now, as
// printing loads them, and are waited for as the page's own are (--timeout
// bounds it): an image until it loads or fails, a frame until its load
// event or until it stops loading without one, as with a 204 or a download
// (measured, Chromium 158).
async function loadDeferred(page: Page): Promise<void> {
  await Promise.all(documentFrames(page).map(async (f) => {
    const client = (f as unknown as { client?: CDPSession }).client;
    const frames = client ? await f.$$('iframe[loading="lazy" i]').catch(() => []) : [];
    await Promise.all([
      ...frames.map((el) => loadFrame(el as ElementHandle<HTMLIFrameElement>, client!)),
      f.evaluate(async () => {
        const waiting = Array.from(document.querySelectorAll<HTMLImageElement>('img[loading="lazy" i]')).filter((e) => !e.complete);
        const loaded = waiting.map((e) => new Promise<void>((ok) => {
          e.addEventListener('load', () => ok(), { once: true });
          e.addEventListener('error', () => ok(), { once: true });
        }));
        for (const e of waiting) e.loading = 'eager';
        await Promise.all(loaded);
      }).catch(() => {}),
    ]);
    await f.evaluate(() => Promise.all(Array.from(document.images, (i) => i.decode().catch(() => {})))).catch(() => {});
  }));
}

// A deferred frame of client's frame: it starts on its address set again,
// not on the change of loading alone (Chromium 158); one with srcdoc is
// left. Its session tells when it stops loading.
async function loadFrame(el: ElementHandle<HTMLIFrameElement>, client: CDPSession): Promise<void> {
  type Loading = { frameId: string };
  let started = false;
  let onStart = (_: Loading) => {};
  let onStop = (_: Loading) => {};
  try {
    if (!await el.evaluate((e) => !e.hasAttribute('srcdoc') && /^(https?|file|data):/i.test(e.src) && e.contentDocument?.URL === 'about:blank')) return;
    const { node } = await client.send('DOM.describeNode', { objectId: el.remoteObject().objectId });
    const stopped = new Promise<void>((ok) => {
      onStart = (e) => { if (e.frameId === node.frameId) started = true; };
      onStop = (e) => { if (e.frameId === node.frameId && started) ok(); };
      client.on('Page.frameStartedLoading', onStart);
      client.on('Page.frameStoppedLoading', onStop);
    });
    await Promise.race([
      stopped,
      el.evaluate((e) => new Promise<void>((ok) => {
        e.addEventListener('load', () => ok(), { once: true });
        e.loading = 'eager';
        e.src = e.src;
      })),
    ]);
  } catch {
    // Left as it is.
  } finally {
    client.off('Page.frameStartedLoading', onStart);
    client.off('Page.frameStoppedLoading', onStop);
  }
}
