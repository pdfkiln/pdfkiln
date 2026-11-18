// The Chromium of one conversion, as both commands start it: a Chromium of
// its own, through the relay with --kiln-block-private-network, else
// through --proxy; with Qt's default font; deaf to certificate errors, as
// wkhtmltopdf, unless --kiln-block-invalid-certificates; with XSLT only
// for a table of contents that has --xsl-style-sheet; stopped at
// --kiln-timeout.
import type { BrowserContext } from 'puppeteer-core';
import { deadline, launch, removeQuietly, type Session } from '../engine/browser.js';
import { noAliasEnv, qtDefaultFamily } from '../engine/fonts.js';
import { startRelay, type Relay, type RelayProxy } from '../engine/relay.js';
import { readJar, writeJar, type QtJar } from './cookiejar.js';
import type { Feedback } from './feedback.js';
import type { LoadedPage } from '../engine/loader.js';
import type { PdfGlobal, Proxy } from './settings.js';

export class Chromium {
  session?: Session;
  relay?: Relay;
  // The proxy Chromium goes through, for the requests the command makes
  // itself (fonts): none with the relay.
  upstream?: RelayProxy;
  fontFamily?: string;
  private stopDeadline = () => {};

  async start(g: PdfGlobal, proxy: Proxy | null, bypass: string[], work: string, fb: Feedback, onTimeout: (line: string) => void, opts: { meanwhile?: () => void; xslt?: boolean } = {}): Promise<BrowserContext> {
    if (g.kiln.blockPrivateNetwork) {
      this.relay = await startRelay();
      if (proxy) fb.warning('--proxy is ignored with --kiln-block-private-network');
    }
    // fc-match runs while Chromium starts: the setup without substitutions
    // only needs fontconfig to answer, the family itself serves the pages.
    // If fc-match starts but finds nothing, Chromium keeps that setup and
    // the pages their own generic families.
    const fonts = qtDefaultFamily();
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
    this.fontFamily = await fonts.family;
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

export async function saveJar(lp: LoadedPage, path: string, jar: QtJar): Promise<void> {
  const { cookies } = await lp.cdp.send('Network.getAllCookies') as { cookies: { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean; session: boolean }[] };
  writeJar(path, jar.toWrite(cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.session ? undefined : c.expires, secure: c.secure, httpOnly: c.httpOnly }))));
}
