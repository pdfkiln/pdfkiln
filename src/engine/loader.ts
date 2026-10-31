// Loads one page in Chromium the way wkhtmltopdf 0.12.6 loads it
// (src/lib/multipageloader.cc): its network rules, its waits, its messages
// and its error codes; the native interface takes the failures instead of
// the messages (Reporter.failed). Every request goes through the DevTools
// Fetch domain: local files are checked and served from here, style sheets
// are rewritten for the emulations, fonts get the CORS header WebKit did
// not need.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { BrowserContext, CDPSession, Page } from 'puppeteer-core';
import type { LoadPage, PostItem, Web } from '../wk/settings.js';
import { qtErrorForChromium, qtErrorForHttpStatus, qtErrorString } from '../wk/qtnet.js';
import { emulateInPage, rewriteCss, type Emulation } from './emulation.js';
import { canonical, contentType, FileAccess, filePath, qtPath, readLocal } from './files.js';
import { BlockedAddress, relayGet, relayRequest, type ClientCert } from './relay.js';

export interface Reporter {
  warning(message: string): void;
  error(message: string): void;
  // Given, a request that does not load comes here, and none of
  // wkhtmltopdf's messages about it: the native interface words it. page:
  // the page itself, not one of its resources.
  failed?(url: string, why: Failure, page: boolean): void;
}

// Why a request did not load: its HTTP status, the network error as
// Chromium names it (net::ERR_…), or the error of a request made here
// (fonts: BlockedAddress, the system's error).
export type Failure = number | string | Error;

export interface LoadSpec {
  url: string;
  web: Web;
  load: LoadPage;
  // The main loader runs --run-script and waits for --window-status;
  // header and footer loaders do not.
  isMain: boolean;
  // Files the page may read besides the page itself and --allow.
  allowFiles?: string[];
  media: 'screen' | 'print';
  viewport: { width: number; height: number };
  emulation?: Emulation;
  // Family for every generic family (wkhtmltopdf's default font).
  fontFamily?: string;
  blockPrivateNetwork: boolean;
  userStyleSheet?: string; // CSS text
  // The native interface's own: headers for every request to the page's
  // host and no other, a style sheet after the page's own, which it
  // overrides, and an element to wait for before the delay.
  siteHeaders?: [string, string][];
  css?: string;
  waitFor?: string;
}

// Media files: their load errors follow --load-media-error-handling.
const MEDIA = new Set(['css', 'js', 'png', 'jpg', 'jpeg', 'gif']);

// Beacons and CSP reports load nothing into the page, and wkhtmltopdf's
// WebKit never sent them: their errors are not the page's, and the wait
// does not wait for them.
const isReport = (type?: string) => type === 'Ping' || type === 'CSPViolationReport';

// QFileInfo(url).completeSuffix(): what follows the first dot of the name.
function completeSuffix(url: string): string {
  const name = url.split('/').pop() ?? '';
  const dot = name.indexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase().replace(/\?.*$/, '');
}

function hasCharset(html: Buffer): boolean {
  const head = html.subarray(0, 2048).toString('latin1');
  return /^\xef\xbb\xbf|^\xfe\xff|^\xff\xfe/.test(head) || /<meta[^>]+charset/i.test(head);
}

export class LoadedPage {
  errorCode = 0; // HTTP status, or 1000 + a QNetworkReply error
  ok = true;
  skipped = false;
  printRequested = false;
  title = '';
  status = 0; // of the page itself, once loaded; 0 without one (data:)
  constructor(readonly page: Page, readonly cdp: CDPSession, readonly spec: LoadSpec) {}
}

// The body of --post and --post-file (ResourceObject::load): a form, or
// multipart when a file is sent. Written to the standards where
// wkhtmltopdf's Qt 4 was not: '+' encoded, CRLF lines, "; boundary=".
// A file that cannot be read throws.
export function postBody(items: PostItem[]): { contentType: string; body: Buffer } | null {
  if (!items.length) return null;
  if (!items.some((i) => i.file)) {
    return { contentType: 'application/x-www-form-urlencoded', body: Buffer.from(new URLSearchParams(items.map((i) => [i.name, i.value])).toString()) };
  }
  const boundary = randomUUID().replace(/-/g, '');
  const parts: Buffer[] = [];
  for (const i of items) {
    const name = i.name.replace(/"/g, '%22');
    const head = i.file
      ? `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${basename(i.value).replace(/"/g, '%22')}"\r\n\r\n`
      : `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`;
    parts.push(Buffer.from(head), i.file ? readFileSync(i.value) : Buffer.from(i.value), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

// wkhtmltopdf presents a client certificate when the three options are
// given and the files read, and says nothing otherwise.
function clientCertOf(load: LoadPage): ClientCert | undefined {
  if (!load.clientSslKeyPath || !load.clientSslKeyPassword || !load.clientSslCrtPath) return undefined;
  try {
    return { cert: readFileSync(load.clientSslCrtPath), key: readFileSync(load.clientSslKeyPath), passphrase: load.clientSslKeyPassword };
  } catch {
    return undefined;
  }
}

export async function openPage(context: BrowserContext, spec: LoadSpec, out: Reporter): Promise<LoadedPage> {
  const page = await context.newPage();
  const cdp = await page.createCDPSession();
  const lp = new LoadedPage(page, cdp, spec);
  const { load, web } = spec;

  const access = new FileAccess(load.blockLocalFileAccess, Boolean(out.failed));
  for (const a of load.allowed) access.allow(a);
  for (const a of spec.allowFiles ?? []) access.allow(a);
  const own = spec.url.startsWith('file:') ? filePath(spec.url) : null;
  if (own) access.allow(own);

  // amfinished: the last error of a page that is not a media file wins.
  const fail = (url: string, ns: number, hs: number, errorString: string, why: Failure, page = false) => {
    if (out.failed) {
      // A resource canceled without an HTTP error did not fail.
      if (page || ns !== 5 || hs > 399) out.failed(url, why, page);
      return;
    }
    if (!((ns !== 0 && ns !== 5) || (hs > 399 && lp.errorCode === 0))) return;
    const code = ns > 0 ? ns + 1000 : hs;
    if (!MEDIA.has(completeSuffix(url))) {
      out.error(`Failed to load ${url}, with network status code ${ns} and http status code ${hs} - ${errorString}`);
      lp.errorCode = code;
      return;
    }
    if (load.mediaLoadErrorHandling === 'abort') {
      lp.errorCode = code;
      out.error(`Failed to load ${url}, with code: ${code} (sometimes it will work just to ignore this error with --load-media-error-handling ignore)`);
    } else {
      out.warning(`Failed to load ${url} (${load.mediaLoadErrorHandling})`);
    }
  };

  // Errors of http requests, from the Network domain, except those of the
  // requests answered here, reported when answered.
  const urls = new Map<string, string>();
  const answered = new Set<string>();
  const reports = new Set<string>();
  let mainDocument = '';
  // Requests still in flight: the page may yet change.
  const inflight = new Set<string>();
  cdp.on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string; headers: Record<string, string> }; type?: string; frameId?: string }) => {
    urls.set(e.requestId, e.request.url);
    // The Network domain types a CSP report "Other", the Fetch domain
    // "CSPViolationReport".
    if (isReport(e.type) || /^application\/csp-report/i.test(e.request.headers['Content-Type'] ?? '')) reports.add(e.requestId);
    else if (!e.request.url.startsWith('data:')) inflight.add(e.requestId);
    if (!mainDocument && e.type === 'Document') mainDocument = e.requestId;
  });
  cdp.on('Network.loadingFinished', (e: { requestId: string }) => inflight.delete(e.requestId));
  const httpError = (url: string, status: number, statusText: string, page = false) => {
    const ns = qtErrorForHttpStatus(status);
    fail(url, ns, status, qtErrorString(ns, url, status, statusText || httpReason(status)), status, page);
  };
  cdp.on('Network.responseReceived', (e: { requestId: string; response: { url: string; status: number; statusText: string } }) => {
    const { url, status, statusText } = e.response;
    if (!/^https?:/.test(url) || status < 400 || answered.has(e.requestId) || reports.has(e.requestId)) return;
    httpError(url, status, statusText, e.requestId === mainDocument);
  });
  // A response Chromium keeps from the page gets no responseReceived: its
  // status comes from the network service, before or after the failure.
  // wkhtmltopdf's WebKit read it. Blocked by ORB or CORP (HTML for an
  // image), it was a response like any other; failing CORS (an API without
  // CORS headers), it was canceled once its status came, which reports an
  // error status only (measured on 0.12.6).
  const statuses = new Map<string, number>();
  const withheld = new Map<string, (status: number) => void>();
  cdp.on('Network.responseReceivedExtraInfo', (e: { requestId: string; statusCode: number }) => {
    statuses.set(e.requestId, e.statusCode);
    withheld.get(e.requestId)?.(e.statusCode);
  });
  cdp.on('Network.loadingFailed', (e: { requestId: string; errorText: string; canceled?: boolean; blockedReason?: string; corsErrorStatus?: object }) => {
    inflight.delete(e.requestId);
    const url = urls.get(e.requestId) ?? '';
    if (!/^https?:/.test(url) || answered.has(e.requestId) || reports.has(e.requestId) || e.errorText === 'net::ERR_BLOCKED_BY_CLIENT') return;
    if (e.blockedReason || e.corsErrorStatus || e.errorText === 'net::ERR_BLOCKED_BY_ORB') {
      const read = (status: number) => {
        if (e.corsErrorStatus) fail(url, 5, status, qtErrorString(5, url, status, ''), status);
        else if (status >= 400) httpError(url, status, '');
      };
      const status = statuses.get(e.requestId);
      if (status === undefined) withheld.set(e.requestId, read);
      else read(status);
      return;
    }
    const ns = e.canceled ? 5 : qtErrorForChromium(e.errorText);
    const page = e.requestId === mainDocument;
    // Qt never reported a refused connection on the page itself.
    if (page && ns === 1 && !out.failed) return;
    fail(url, ns, 0, qtErrorString(ns, url, 0, ''), e.errorText, page);
  });

  // Fetch: every request, and style sheet responses to rewrite.
  const rewrite = spec.emulation && (spec.emulation.mediaViewport || spec.emulation.dropPageRules || spec.emulation.screenTypes || spec.emulation.webkit534Css) ? spec.emulation : undefined;
  let mainHeadersSent = false;
  let posted = false;
  const post = postBody(load.post);
  const clientCert = clientCertOf(load);
  cdp.on('Fetch.requestPaused', (e: FetchPaused) => {
    handle(e).catch(() => cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {}));
  });
  const handle = async (e: FetchPaused) => {
    const { requestId, request } = e;
    const url = request.url;
    if (e.responseStatusCode !== undefined || e.responseErrorReason) {
      // A style sheet response, to rewrite.
      if (e.responseErrorReason || !rewrite) return cdp.send('Fetch.continueRequest', { requestId });
      const body = await cdp.send('Fetch.getResponseBody', { requestId });
      const css = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8').toString('utf8');
      const headers = (e.responseHeaders ?? []).filter((h) => !/^(content-length|content-encoding)$/i.test(h.name));
      return cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: e.responseStatusCode ?? 200,
        responseHeaders: headers,
        body: Buffer.from(rewriteCss(css, rewrite)).toString('base64'),
      });
    }
    if (url.startsWith('file:')) return serveFile(e);
    if (!web.loadImages && e.resourceType === 'Image') {
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
    if (e.resourceType === 'Font' && /^https?:/.test(url)) return relayFont(e);
    // --custom-header without propagation, and --post: the page request
    // only.
    const headersHere = !mainHeadersSent && load.customHeaders.length > 0 && !load.repeatCustomHeaders;
    const postHere = !posted && post !== null && /^https?:/.test(url);
    const main = e.resourceType === 'Document' && (headersHere || postHere);
    let headers: { name: string; value: string }[] | undefined;
    let postData: Buffer | undefined;
    if (main) {
      mainHeadersSent = true;
      posted = true;
      headers = Object.entries(request.headers).map(([name, value]) => ({ name, value }));
      if (headersHere) for (const [name, value] of load.customHeaders) headers.push({ name, value });
      if (postHere) {
        headers = headers.filter((h) => !/^content-(type|length)$/i.test(h.name));
        headers.push({ name: 'Content-Type', value: post.contentType });
        postData = post.body;
      }
    }
    // The native --header: with every request to the page's host, in place
    // of the browser's own of the same name, and to no other host.
    const site = Boolean(spec.siteHeaders?.length) && URL.parse(url)?.hostname === URL.parse(spec.url)?.hostname;
    if (site) {
      const names = new Set(spec.siteHeaders!.map(([name]) => name.toLowerCase()));
      headers = (headers ?? Object.entries(request.headers).map(([name, value]) => ({ name, value }))).filter((h) => !names.has(h.name.toLowerCase()));
      for (const [name, value] of spec.siteHeaders!) headers.push({ name, value });
    }
    // Chromium cannot be given a client certificate: the command makes
    // the request.
    if (clientCert && url.startsWith('https:')) return relayTls(e, headers, postData);
    if (main || site) return cdp.send('Fetch.continueRequest', { requestId, headers, ...(postData ? { method: 'POST', postData: postData.toString('base64') } : {}) });
    if (rewrite && e.resourceType === 'Stylesheet') return cdp.send('Fetch.continueRequest', { requestId, interceptResponse: true });
    return cdp.send('Fetch.continueRequest', { requestId });
  };

  const serveFile = async (e: FetchPaused) => {
    const { requestId, request } = e;
    const path = filePath(request.url.split('#')[0]!);
    if (!path || !access.allows(path)) {
      if (out.failed) out.failed(request.url, 'net::ERR_ACCESS_DENIED', false);
      else {
        // wkhtmltopdf loads about:blank instead, which Qt cannot load.
        const c = path && canonical(path);
        out.warning(`Blocked access to file ${c ? qtPath(c) : ''}`);
        fail('about:blank', 301, 0, 'Protocol "about" is unknown', '');
      }
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' });
    }
    const data = await readLocal(path);
    if (!data) {
      fail(request.url, 203, 0, `Error opening ${qtPath(path)}: No such file or directory`, 'net::ERR_FILE_NOT_FOUND', e.resourceType === 'Document' && path === own);
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    }
    let body = data;
    let type = contentType(path);
    const ext = extname(path).toLowerCase();
    if (ext === '.css' && rewrite) body = Buffer.from(rewriteCss(data.toString('utf8'), rewrite));
    if ((ext === '.html' || ext === '.htm') && web.defaultEncoding && !hasCharset(data)) type = contentType(path, web.defaultEncoding);
    return cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: type }],
      body: body.toString('base64'),
    });
  };

  // WebKit loaded web fonts from any origin; Chromium applies CORS to them,
  // and a page opened from a file has the origin "null". The check comes
  // before response interception: the font is fetched here.
  const relayTls = async (e: FetchPaused, headers?: { name: string; value: string }[], body?: Buffer) => {
    const { requestId, request } = e;
    if (e.networkId) answered.add(e.networkId);
    const h: Record<string, string> = {};
    for (const { name, value } of headers ?? Object.entries(request.headers).map(([name, value]) => ({ name, value }))) {
      if (!/^accept-encoding$/i.test(name)) h[name] = value;
    }
    h['Accept-Encoding'] = 'identity';
    // Chromium adds the cookies after this stage.
    if (!Object.keys(h).some((k) => /^cookie$/i.test(k))) {
      const { cookies } = await cdp.send('Network.getCookies', { urls: [request.url] });
      if (cookies.length) h.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    const sent = body ?? (request.postDataEntries?.length ? Buffer.concat(request.postDataEntries.map((p) => Buffer.from(p.bytes ?? '', 'base64'))) : undefined);
    try {
      const r = await relayRequest(request.url, { block: spec.blockPrivateNetwork, method: body ? 'POST' : request.method, headers: h, body: sent, tls: clientCert });
      const responseHeaders = r.headers
        .filter(([k]) => !/^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i.test(k))
        .map(([name, value]) => ({ name, value }));
      if (r.status >= 400 && !isReport(e.resourceType)) fail(request.url, qtErrorForHttpStatus(r.status), r.status, qtErrorString(qtErrorForHttpStatus(r.status), request.url, r.status, r.statusText), r.status);
      let data = r.body;
      if (rewrite && e.resourceType === 'Stylesheet' && r.status < 300) data = Buffer.from(rewriteCss(data.toString('utf8'), rewrite));
      if (e.resourceType === 'Font') responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: r.status, responseHeaders, body: data.toString('base64') });
    } catch (err) {
      // QNetworkReply's codes: host not found, refused, closed, the
      // proxy's refusal for a blocked address, the handshake.
      const code = (err as { code?: string }).code;
      const ns = code === 'ENOTFOUND' ? 3 : code === 'ECONNREFUSED' ? 1 : code === 'ECONNRESET' ? 2 : err instanceof BlockedAddress ? 102 : 6;
      if (!isReport(e.resourceType)) fail(request.url, ns, 0, qtErrorString(ns, request.url, 0, ''), err as Error);
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    }
  };

  const relayFont = async (e: FetchPaused) => {
    const { requestId, request } = e;
    if (e.networkId) answered.add(e.networkId);
    try {
      const r = await relayGet(request.url, { block: spec.blockPrivateNetwork, headers: { 'user-agent': request.headers['User-Agent'] ?? '' }, tls: clientCert });
      const headers = r.headers
        .filter(([k]) => !/^(access-control-allow-origin|content-encoding|content-length|transfer-encoding|connection)$/i.test(k))
        .map(([name, value]) => ({ name, value }));
      headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      if (r.status >= 400) fail(request.url, qtErrorForHttpStatus(r.status), r.status, qtErrorString(qtErrorForHttpStatus(r.status), request.url, r.status, r.statusText), r.status);
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: r.status, responseHeaders: headers, body: r.body.toString('base64') });
    } catch (err) {
      const ns = (err as { code?: string }).code === 'ENOTFOUND' ? 3 : 99;
      fail(request.url, ns, 0, qtErrorString(ns, request.url, 0, ''), err as Error);
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
    }
  };

  // HTTP authentication: --username and --password, two tries.
  let loginTry = 0;
  cdp.on('Fetch.authRequired', (e: { requestId: string; authChallenge: { source?: string } }) => {
    const proxy = e.authChallenge.source === 'Proxy';
    const user = proxy ? load.proxy?.user ?? '' : load.username;
    const password = proxy ? load.proxy?.password ?? '' : load.password;
    let response: 'ProvideCredentials' | 'CancelAuth' = 'ProvideCredentials';
    if (!user) {
      // The native interface reports the 401 as the request's failure.
      if (!out.failed) out.error(proxy ? 'Proxy Authentication Required' : 'Authentication Required');
      response = 'CancelAuth';
    } else if (loginTry >= 2) {
      out.error('Invalid username or password');
      response = 'CancelAuth';
    } else loginTry++;
    cdp.send('Fetch.continueWithAuth', {
      requestId: e.requestId,
      authChallengeResponse: response === 'CancelAuth' ? { response } : { response, username: user, password },
    }).catch(() => {});
  });

  // JavaScript dialogs are answered, as wkhtmltopdf did.
  cdp.on('Page.javascriptDialogOpening', (e: { type: string; message: string; defaultPrompt?: string }) => {
    if (e.type === 'alert') out.warning(`Javascript alert: ${e.message}`);
    else if (e.type === 'confirm') out.warning(`Javascript confirm: ${e.message} (answered yes)`);
    else if (e.type === 'prompt') out.warning(`Javascript prompt: ${e.message} (answered ${e.defaultPrompt ?? ''})`);
    cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: e.defaultPrompt ?? '' }).catch(() => {});
  });

  // window.print() ends the wait, as in wkhtmltopdf.
  let printed: () => void = () => {};
  const printCalled = new Promise<void>((r) => (printed = r));
  cdp.on('Runtime.bindingCalled', (e: { name: string }) => {
    if (e.name === '__pdfkilnPrint') {
      lp.printRequested = true;
      printed();
    }
  });

  await Promise.all([
    cdp.send('Network.enable'),
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true }),
    cdp.send('Emulation.setEmulatedMedia', { media: spec.media }),
    cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.max(1, Math.round(spec.viewport.width)), height: Math.max(1, Math.round(spec.viewport.height)), deviceScaleFactor: 1, mobile: false }),
    web.enableJavascript ? undefined : cdp.send('Emulation.setScriptExecutionDisabled', { value: true }),
    load.repeatCustomHeaders && load.customHeaders.length
      ? cdp.send('Network.setExtraHTTPHeaders', { headers: Object.fromEntries(load.customHeaders) })
      : undefined,
    spec.fontFamily
      ? cdp.send('Page.setFontFamilies', {
        fontFamilies: { standard: spec.fontFamily, fixed: spec.fontFamily, serif: spec.fontFamily, sansSerif: spec.fontFamily, cursive: spec.fontFamily, fantasy: spec.fontFamily, math: spec.fontFamily },
      })
      : undefined,
    cdp.send('Runtime.addBinding', { name: '__pdfkilnPrint' }),
    cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.print = () => { try { window.__pdfkilnPrint(''); } catch {} };
        // WebRTC would reach the network around the relay.
        delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection; delete window.RTCDataChannel;
        // What may still change the page: timers, intervals, animation
        // frames, and the DOM changed in the last 50 ms (see quiet()).
        const w = window, timers = new Set(), frames = new Set();
        const st = w.setTimeout, ct = w.clearTimeout, si = w.setInterval, ci = w.clearInterval;
        const raf = w.requestAnimationFrame, caf = w.cancelAnimationFrame;
        let changed = 0;
        w.setTimeout = function (fn, ms, ...args) {
          const id = st.call(w, function () { timers.delete(id); return typeof fn === 'function' ? fn.apply(this, args) : (0, eval)(String(fn)); }, ms);
          timers.add(id);
          return id;
        };
        w.setInterval = function (...a) { const id = si.apply(w, a); timers.add(id); return id; };
        w.clearTimeout = w.clearInterval = function (id) { timers.delete(id); ct.call(w, id); ci.call(w, id); };
        w.requestAnimationFrame = function (cb) { const id = raf.call(w, (t) => { frames.delete(id); cb(t); }); frames.add(id); return id; };
        w.cancelAnimationFrame = function (id) { frames.delete(id); caf.call(w, id); };
        new MutationObserver(() => { changed = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        Object.defineProperty(w, '__pdfkilnBusy', { value: () => timers.size > 0 || frames.size > 0 || performance.now() - changed < 50 });
      })();`,
    }),
  ]);
  if (load.cookies.length && /^https?:/.test(spec.url)) {
    await cdp.send('Network.setCookies', {
      cookies: load.cookies.map(([name, value]) => ({ name, value, url: spec.url })),
    });
  }

  // Load, then run-script, then window-status, then the delay.
  try {
    lp.status = (await page.goto(spec.url, { waitUntil: 'load', timeout: 0 }))?.status() ?? 0;
  } catch (e) {
    lp.ok = false;
    // After the request's own failure, when it had one.
    const message = e instanceof Error ? e.message : String(e);
    out.failed?.(spec.url, /net::ERR_\w+/.exec(message)?.[0] ?? message, true);
  }
  if (!lp.ok) {
    if (out.failed) return lp;
    if (load.loadErrorHandling === 'abort') {
      out.error(`Failed loading page ${spec.url} (sometimes it will work just to ignore this error with --load-error-handling ignore)`);
    } else if (load.loadErrorHandling === 'skip') {
      out.warning(`Failed loading page ${spec.url} (skipped)`);
      lp.skipped = true;
    } else {
      out.warning(`Failed loading page ${spec.url} (ignored)`);
    }
    return lp;
  }
  if (spec.userStyleSheet) {
    await Promise.all(page.frames().map((f) => f.evaluate((css: string) => {
      const s = document.createElement('style');
      s.textContent = css;
      (document.head ?? document.documentElement).prepend(s);
    }, spec.userStyleSheet!).catch(() => {})));
  }
  // The native --css: last in the page, it wins over the page's own rules
  // (@page included).
  if (spec.css) {
    await page.evaluate((css: string) => {
      const s = document.createElement('style');
      s.textContent = css;
      document.documentElement.append(s);
    }, spec.css).catch(() => {});
  }
  // The native --wait-for, whatever the delay; --timeout bounds it.
  // Puppeteer waits on an invalid selector as on any other: checked first.
  if (spec.waitFor) {
    const valid = await page.evaluate((selector: string) => {
      try {
        document.querySelector(selector);
        return true;
      } catch {
        return false;
      }
    }, spec.waitFor).catch(() => true);
    if (!valid) throw new Error(`--wait-for takes a CSS selector, not ${spec.waitFor}`);
    await Promise.race([page.waitForSelector(spec.waitFor, { timeout: 0 }), printCalled]).catch(() => {});
  }
  if (spec.isMain) {
    for (const js of load.runScript) {
      await cdp.send('Runtime.evaluate', { expression: js, userGesture: true }).catch(() => {});
    }
  }
  if (load.jsdelay > 0 && !lp.printRequested) {
    if (spec.isMain && load.windowStatus) {
      await Promise.race([
        (async () => {
          for (;;) {
            const s = await page.evaluate(() => window.status).catch(() => '');
            if (s === load.windowStatus) break;
            await new Promise((r) => setTimeout(r, 50));
          }
        })(),
        printCalled,
      ]);
    }
    if (!lp.printRequested) await Promise.race([settle(page, inflight, load.jsdelay), printCalled]);
  }
  lp.title = await page.title().catch(() => '');
  return lp;
}

// The JavaScript delay, cut short once nothing can change the page any
// more: no timer, interval or animation frame pending, no request in
// flight, the fonts loaded, no animation running, the DOM still for 50 ms,
// in every frame, for 20 ms. wkhtmltopdf always waits the whole delay; the
// PDF is the same, sooner.
async function settle(page: Page, inflight: Set<string>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  let quietSince = 0;
  const busy = async () => {
    if (inflight.size) return true;
    for (const f of page.frames()) {
      const b = await f.evaluate(() => {
        const w = window as unknown as { __pdfkilnBusy?: () => boolean };
        if (w.__pdfkilnBusy?.()) return true;
        return document.fonts?.status === 'loading' || document.getAnimations().some((a) => a.playState === 'running');
      }).catch(() => false);
      if (b) return true;
    }
    return false;
  };
  while (Date.now() < end) {
    if (await busy()) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= 20) return;
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10, end - Date.now()))));
  }
}

// The emulations, in every frame, just before printing.
export async function emulate(lp: LoadedPage): Promise<void> {
  const e = lp.spec.emulation;
  if (!e) return;
  await Promise.all(lp.page.frames().map((f) => f.evaluate(emulateInPage, e).catch(() => {})));
}

interface FetchPaused {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string>; postDataEntries?: { bytes?: string }[] };
  resourceType: string;
  frameId: string;
  networkId?: string;
  responseStatusCode?: number;
  responseErrorReason?: string;
  responseHeaders?: { name: string; value: string }[];
}

function httpReason(status: number): string {
  const r: Record<number, string> = {
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
    408: 'Request Timeout', 410: 'Gone', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  return r[status] ?? '';
}
