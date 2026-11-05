// The Chromium of one conversion, as both commands start it: a Chromium of
// its own, through the relay with --kiln-block-private-network, else
// through --proxy; with Qt's default font; stopped at --kiln-timeout.
import type { BrowserContext } from 'puppeteer-core';
import { deadline, launch, removeQuietly, type Session } from '../engine/browser.js';
import { noAliasEnv, qtDefaultFamily } from '../engine/fonts.js';
import { startRelay, type Relay } from '../engine/relay.js';
import { readJar, writeJar } from './cookiejar.js';
import type { Feedback } from './feedback.js';
import type { LoadedPage } from '../engine/loader.js';
import type { PdfGlobal, Proxy } from './settings.js';

export class Chromium {
  session?: Session;
  relay?: Relay;
  fontFamily?: string;
  private stopDeadline = () => {};

  async start(g: PdfGlobal, proxy: Proxy | null, bypass: string[], work: string, fb: Feedback, onTimeout: (line: string) => void, meanwhile?: () => void): Promise<BrowserContext> {
    if (g.kiln.blockPrivateNetwork) {
      this.relay = await startRelay();
      if (proxy) fb.warning('--proxy is ignored with --kiln-block-private-network');
    }
    this.fontFamily = qtDefaultFamily();
    const relay = this.relay;
    // Even loopback addresses go through the relay.
    const proxyServer = relay?.url ?? (proxy ? `${proxy.type}://${proxy.host}:${proxy.port}` : undefined);
    const proxyBypass = relay ? ['<-loopback>'] : proxy?.host ? bypass : [];
    this.session = await launch({
      dir: work,
      noSandbox: g.kiln.noSandbox,
      proxyServer,
      proxyBypassList: proxyBypass.join(';') || undefined,
      env: this.fontFamily ? noAliasEnv(work) : {},
      meanwhile,
    });
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

export async function loadJar(context: BrowserContext, path: string): Promise<void> {
  const cookies = readJar(path).filter((c) => c.domain);
  if (!cookies.length) return;
  await context.setCookie(...cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain!, path: c.path ?? '/', secure: c.secure, httpOnly: c.httpOnly,
    expires: c.expires,
  })));
}

export async function saveJar(lp: LoadedPage, path: string): Promise<void> {
  const { cookies } = await lp.cdp.send('Network.getAllCookies') as { cookies: { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean; session: boolean }[] };
  writeJar(path, cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.session ? undefined : c.expires, secure: c.secure, httpOnly: c.httpOnly })));
}
