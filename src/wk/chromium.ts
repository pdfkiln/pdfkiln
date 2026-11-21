// The Chromium of one conversion, as both commands start it: a Chromium of
// its own, through the relay with --kiln-block-private-network, else
// through --proxy; with Qt's fonts; deaf to certificate errors, as
// wkhtmltopdf, unless --kiln-block-invalid-certificates; with XSLT only
// for a table of contents that has --xsl-style-sheet; stopped at
// --kiln-timeout.
import type { BrowserContext, Page } from 'puppeteer-core';
import { deadline, launch, removeQuietly, type Session } from '../engine/browser.js';
import { noAliasEnv, qtFonts, type GenericFamilies } from '../engine/fonts.js';
import { startRelay, type Relay, type RelayProxy } from '../engine/relay.js';
import { readJar, writeJar, type QtJar } from './cookiejar.js';
import type { Feedback } from './feedback.js';
import type { LoadedPage } from '../engine/loader.js';
import type { JpegToGray } from '../pdf/grayscale.js';
import type { PdfGlobal, Proxy } from './settings.js';

export class Chromium {
  session?: Session;
  relay?: Relay;
  // The proxy Chromium goes through, for the requests the command makes
  // itself (fonts): none with the relay.
  upstream?: RelayProxy;
  fontFamilies?: GenericFamilies;
  private stopDeadline = () => {};

  async start(g: PdfGlobal, proxy: Proxy | null, bypass: string[], work: string, fb: Feedback, onTimeout: (line: string) => void, opts: { meanwhile?: () => void; xslt?: boolean } = {}): Promise<BrowserContext> {
    if (g.kiln.blockPrivateNetwork) {
      this.relay = await startRelay();
      if (proxy) fb.warning('--proxy is ignored with --kiln-block-private-network');
    }
    // fontconfig runs while Chromium starts: the setup without substitutions
    // only needs it to answer, the families themselves serve the pages. If
    // it starts but gives no family, Chromium keeps that setup and the pages
    // their own generic families.
    const fonts = qtFonts();
    const withFonts = await fonts.started;
    const relay = this.relay;
    // Even loopback addresses go through the relay.
    const proxyServer = relay?.url ?? (proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : undefined);
    const proxyBypass = relay ? ['<-loopback>'] : proxy?.host ? bypass : [];
    this.upstream = !relay && proxy?.host ? { server: proxy, bypass } : undefined;
    this.session = await launch({
      dir: work,
      noSandbox: g.kiln.noSandbox,
      proxyServer,
      proxyBypassList: proxyBypass.join(';') || undefined,
      ignoreCertificateErrors: !g.kiln.blockInvalidCertificates,
      xslt: opts.xslt,
      env: withFonts ? noAliasEnv(work) : {},
      meanwhile: opts.meanwhile,
    });
    this.fontFamilies = await fonts.families;
    this.stopDeadline = deadline(this.session, g.kiln.timeout, () => {
      // Written even with --quiet, as wkhtmltopdf's last line.
      removeQuietly(work);
      onTimeout(`Exit with code 1, the conversion took longer than ${g.kiln.timeout} s (--kiln-timeout)`);
    });
    return this.session.browser.defaultBrowserContext();
  }

  async close(): Promise<void> {
    this.stopDeadline();
    await this.session?.close();
    await this.relay?.close();
  }
}

export async function loadJar(context: BrowserContext, path: string, jar: QtJar): Promise<void> {
  const read = readJar(path);
  const cookies = read.filter((c) => c.domain).map((c) => ({
    name: c.name, value: c.value, domain: c.domain!, path: c.path ?? '/', secure: c.secure, httpOnly: c.httpOnly,
    expires: c.expires,
  }));
  if (cookies.length) {
    // One cookie Chromium refuses fails them all: then one by one, as Qt
    // takes each.
    await context.setCookie(...cookies).catch(async () => {
      for (const c of cookies) await context.setCookie(c).catch(() => {});
    });
  }
  jar.loaded(read, cookies.length ? await context.cookies() : []);
}

// The JPEG images Chromium embeds as they are, in grey for --grayscale:
// decoded by Chromium, in a page of their own, without colour management or
// orientation, as a PDF reader draws them; qGray's weights.
export function grayJpegs(context: BrowserContext): { gray: JpegToGray; close: () => Promise<void> } {
  let page: Promise<Page> | undefined;
  return {
    gray: async (data, width, height) => {
      try {
        const p = await (page ??= context.newPage());
        const out = await p.evaluate(async (b64: string, w: number, h: number) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', imageOrientation: 'none', premultiplyAlpha: 'none' });
          if (bmp.width !== w || bmp.height !== h) return null;
          const g = new OffscreenCanvas(w, h).getContext('2d')!;
          g.drawImage(bmp, 0, 0);
          const px = g.getImageData(0, 0, w, h).data;
          const gray = new Uint8Array(w * h);
          for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (px[i]! * 11 + px[i + 1]! * 16 + px[i + 2]! * 5) >> 5;
          let s = '';
          for (let i = 0; i < gray.length; i += 0x8000) s += String.fromCharCode(...gray.subarray(i, i + 0x8000));
          return btoa(s);
        }, Buffer.from(data).toString('base64'), width, height);
        return out ? new Uint8Array(Buffer.from(out, 'base64')) : undefined;
      } catch {
        return undefined;
      }
    },
    close: async () => {
      await (await page?.catch(() => undefined))?.close().catch(() => {});
    },
  };
}

export async function saveJar(lp: LoadedPage, path: string, jar: QtJar): Promise<void> {
  const { cookies } = await lp.cdp.send('Network.getAllCookies') as { cookies: { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean; session: boolean }[] };
  writeJar(path, jar.toWrite(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.session ? undefined : c.expires, secure: c.secure, httpOnly: c.httpOnly }))));
}
