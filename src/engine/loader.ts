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
import type { BrowserContext, CDPSession, Frame, Page } from 'puppeteer-core';
import type { LoadPage, PostItem, Web } from '../wk/settings.js';
import type { QtJar } from '../wk/cookiejar.js';
import { qtErrorForChromium, qtErrorForHttpStatus, qtErrorString } from '../wk/qtnet.js';
import { emulateInPage, rewriteCss, userLayer, type Emulation } from './emulation.js';
import { cleanDataUrl, cleanDocument } from './webkit534-loads.js';
import { canonical, contentType, FileAccess, filePath, qtPath, readLocal } from './files.js';
import type { GenericFamilies } from './fonts.js';
import { BlockedAddress, CertificateError, relayGet, relayRequest, type ClientCert, type RelayProxy } from './relay.js';
import { isBlock, Withheld } from './withheld.js';

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
  // header, footer and table of contents loaders do not.
  isMain: boolean;
  // Files the page may read besides the page itself and --allow.
  allowFiles?: string[];
  media: 'screen' | 'print';
  // The window, in CSS pixels; scale: device pixels per CSS pixel (1 by
  // default), for the native interface's images.
  viewport: { width: number; height: number; scale?: number };
  emulation?: Emulation;
  // The generic families' fonts (wkhtmltopdf's).
  fontFamilies?: GenericFamilies;
  blockPrivateNetwork: boolean;
  // Load what comes from a server whose certificate does not verify, as
  // wkhtmltopdf does, the requests made here included. Chromium must be
  // started to ignore them too (LaunchOptions).
  ignoreCertificateErrors: boolean;
  // wkhtmltopdf's cookies: those Chromium holds (the --cookie-jar's, the
  // servers') go with each request whose URL they match, whatever the
  // page's site, in the order of Qt's jar. Chromium keeps a cookie without
  // SameSite from a request to another site, and a page opened from a
  // file is another site to every server. --cookie goes to the host of a
  // page loaded from its address only, which wkhtmltopdf sent to every
  // site; a page that has none, a file or the standard input, sends it
  // with every request, as wkhtmltopdf.
  qtCookies?: QtJar;
  userStyleSheet?: string; // CSS text
  // Or its http or https URL, loaded as the page's style sheets are.
  userStyleSheetUrl?: string;
  // The native interface's own: headers for every request to the page's
  // host and no other, a style sheet after the page's own, which it
  // overrides, and an element to wait for before the delay.
  siteHeaders?: [string, string][];
  // The URL whose host is the page's, for the headers and the cookies,
  // when the page printed is not it: Markdown read from a URL, header
  // pages printed in a page of their own.
  site?: string;
  // Chromium's proxy (--proxy, --bypass-proxy-for), which the fonts
  // fetched here go through as the page's other requests do.
  proxy?: RelayProxy;
  css?: string;
  waitFor?: string;
  // The Referer of the page's own request: a frame loaded apart takes the
  // one the page that holds it would send it.
  referer?: string;
}

// Media files: their load errors follow --load-media-error-handling.
const MEDIA = new Set(['css', 'js', 'png', 'jpg', 'jpeg', 'gif']);

// Beacons and CSP reports load nothing into the page, and wkhtmltopdf's
// WebKit never sent them: their errors are not the page's, and the wait
// does not wait for them.
const isReport = (type?: string) => type === 'Ping' || type === 'CSPViolationReport';

// A request's headers, to send in place of Chromium's, without its Referer:
// Chromium then keeps it to its referrer policy. Given back, it was pinned,
// and a redirect to another site took the input's whole address, its query
// included (measured, Chromium 158).
const ownHeaders = (h: Record<string, string>) => Object.entries(h).filter(([name]) => !/^referer$/i.test(name)).map(([name, value]) => ({ name, value }));

// Requests whose cookies stay Chromium's (LoadSpec.qtCookies): their
// credentials decide, which the Fetch domain does not tell. Qt's WebKit
// sent none either with an XMLHttpRequest to another origin without
// withCredentials (measured on 0.12.6). One with withCredentials gets the
// jar's, as in wkhtmltopdf: MARK_CREDENTIALS opens it again, its URL
// marked with CREDENTIALS, a fragment, which is not sent.
const OWN_COOKIES = new Set(['XHR', 'Fetch', 'EventSource', 'Preflight', 'Ping', 'CSPViolationReport']);
const CREDENTIALS = '#pdfkiln-credentials';
const MARK_CREDENTIALS = `(() => {
  const X = XMLHttpRequest.prototype, { open, send, setRequestHeader } = X, opened = new WeakMap();
  X.open = function (...args) { opened.set(this, { args, headers: [] }); return open.apply(this, args); };
  X.setRequestHeader = function (name, value) { opened.get(this)?.headers.push([name, value]); return setRequestHeader.call(this, name, value); };
  X.send = function (...body) {
    const o = opened.get(this);
    if (o && !o.sent && this.withCredentials && this.readyState === 1) {
      try {
        const u = new URL(String(o.args[1]), document.baseURI);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          u.hash = '${CREDENTIALS}';
          open.apply(this, [o.args[0], u.href, ...o.args.slice(2)]);
          for (const [name, value] of o.headers) setRequestHeader.call(this, name, value);
        }
      } catch {}
    }
    if (o) o.sent = true;
    return send.apply(this, body);
  };
})();`;

// Why Chromium refuses a cookie a server sets, where Qt's jar took it:
// SameSite, which Qt did not know, and the blocking of other sites' cookies.
const SITE_REFUSALS = new Set([
  'SameSiteStrict', 'SameSiteLax', 'SameSiteUnspecifiedTreatedAsLax', 'SameSiteNoneInsecure',
  'SchemefulSameSiteStrict', 'SchemefulSameSiteLax', 'SchemefulSameSiteUnspecifiedTreatedAsLax',
  'ThirdPartyPhaseout', 'ThirdPartyBlockedInFirstPartySet', 'UserPreferences',
]);

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
  // The window resized, in CSS pixels, then, once its resize event has
  // come, the wait of the load again: the JavaScript delay, cut short once
  // nothing can change the page.
  resize: (width: number, height: number) => Promise<void> = async () => {};
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

// The frames that hold a document. One that waits to be scrolled to
// (loading=lazy) has none, and its URL is empty: Puppeteer would wait its
// default timeout, 30 s, for a document to evaluate in, at each call.
export function documentFrames(page: Page): Frame[] {
  return page.frames().filter((f) => f.url() !== '');
}

// The blank tab Chromium opens at start serves the first page of a
// conversion: opening one costs 60 to 85 ms. Claimed before any wait, as the
// compatible mode opens its pages at once.
const claimed = new WeakSet<BrowserContext>();
async function takePage(context: BrowserContext): Promise<Page> {
  if (!claimed.has(context)) {
    claimed.add(context);
    const blank = (await context.pages()).find((p) => p.url() === 'about:blank');
    if (blank) return blank;
  }
  return context.newPage();
}

export async function openPage(context: BrowserContext, spec: LoadSpec, out: Reporter): Promise<LoadedPage> {
  const page = await takePage(context);
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

  // wkhtmltopdf ignores certificate errors, with a warning for each
  // connection whose certificate did not verify (ResourceObject::sslErrors):
  // Chromium's, by their id, and the requests made here, by their socket.
  // Measured on 0.12.6: one line per connection. The native interface says
  // nothing: its option asked for it.
  const untrusted = new Set<unknown>();
  const sslErrorIgnored = (connection: unknown) => {
    if (out.failed || untrusted.has(connection)) return;
    untrusted.add(connection);
    out.warning('SSL error ignored');
  };
  // A response over https with a certificate error is "insecure", from a
  // Chromium started with --ignore-certificate-errors. Not a style sheet
  // rewritten for the emulations, nor a page cleaned or served with its
  // charset (webkit534Loads): fulfilled here, its response tells neither
  // its connection nor its certificate (connectionId 0, securityState
  // "unknown", Chromium 157), and a connection that only carried them goes
  // without its warning.
  const checkCertificate = (r: { url: string; securityState?: string; connectionId?: number }) => {
    if (spec.ignoreCertificateErrors && r.connectionId && r.url.startsWith('https:') && r.securityState?.startsWith('insecure')) sslErrorIgnored(r.connectionId);
  };

  // Errors of http requests, from the Network domain, except those of the
  // requests answered here, reported when answered.
  const urls = new Map<string, string>();
  const answered = new Set<string>();
  const reports = new Set<string>();
  let mainDocument = '';
  // Requests still in flight: the page may yet change.
  const inflight = new Set<string>();
  cdp.on('Network.requestWillBeSent', (e: { requestId: string; request: { url: string; headers: Record<string, string> }; type?: string; frameId?: string; redirectResponse?: { url: string; securityState?: string; connectionId?: number } }) => {
    if (e.redirectResponse) checkCertificate(e.redirectResponse);
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
  cdp.on('Network.responseReceived', (e: { requestId: string; response: { url: string; status: number; statusText: string; securityState?: string; connectionId?: number } }) => {
    checkCertificate(e.response);
    const { url, status, statusText } = e.response;
    if (!/^https?:/.test(url) || status < 400 || answered.has(e.requestId) || reports.has(e.requestId)) return;
    httpError(url, status, statusText, e.requestId === mainDocument);
  });
  // A response Chromium keeps from the page gets no responseReceived: its
  // status comes from the network service, before or after the failure
  // (withheld.ts). wkhtmltopdf's WebKit read it. Blocked by ORB or CORP
  // (HTML for an image), it was a response like any other; failing CORS (an
  // API without CORS headers), it was canceled once its status came, which
  // reports an error status only (measured on 0.12.6).
  const withheld = new Withheld(inflight);
  cdp.on('Network.responseReceivedExtraInfo', (e: { requestId: string; statusCode: number }) => withheld.status(e.requestId, e.statusCode));
  // A cookie Chromium refuses to take from a response to a page of another
  // site, or opened from a file: wkhtmltopdf keeps it (LoadSpec.qtCookies),
  // so it is set here, without SameSite.
  if (spec.qtCookies) {
    cdp.on('Network.responseReceivedExtraInfo', (e: { requestId: string; blockedCookies?: { blockedReasons: string[]; cookie?: { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean; session: boolean } }[] }) => {
      const url = urls.get(e.requestId);
      const kept = (e.blockedCookies ?? []).flatMap((b) => (b.cookie && b.blockedReasons.every((r) => SITE_REFUSALS.has(r)) ? [b.cookie] : []));
      if (!url || !kept.length) return;
      cdp.send('Network.setCookies', {
        cookies: kept.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.session ? undefined : c.expires })),
      }).catch(() => {});
    });
  }
  cdp.on('Network.loadingFailed', (e: { requestId: string; errorText: string; canceled?: boolean; blockedReason?: string; corsErrorStatus?: { corsError?: string } }) => {
    inflight.delete(e.requestId);
    const url = urls.get(e.requestId) ?? '';
    if (!/^https?:/.test(url) || answered.has(e.requestId) || reports.has(e.requestId) || e.errorText === 'net::ERR_BLOCKED_BY_CLIENT') return;
    if (isBlock(e)) {
      withheld.failed(e.requestId, e, (status) => {
        if (e.corsErrorStatus) fail(url, 5, status, qtErrorString(5, url, status, ''), status);
        else if (status >= 400) httpError(url, status, '');
      });
      return;
    }
    const ns = e.canceled ? 5 : qtErrorForChromium(e.errorText);
    const page = e.requestId === mainDocument;
    fail(url, ns, 0, qtErrorString(ns, url, 0, ''), e.errorText, page);
  });

  // Fetch: every request, and style sheet responses to rewrite.
  const rewrite = spec.emulation && (spec.emulation.mediaViewport || spec.emulation.dropPageRules || spec.emulation.screenTypes || spec.emulation.webkit534Css || spec.emulation.webkit534Loads) ? spec.emulation : undefined;
  // Documents cleaned of what WebKit 534 never loaded, before Chromium
  // reads them: <noscript> is markup without JavaScript.
  const clean = Boolean(spec.emulation?.webkit534Loads);
  // Their style elements and attributes are rewritten for the emulations
  // there, as a style sheet served is: before Chromium reads them, so that
  // they load what WebKit 534 loaded (a media query it found false loads
  // nothing); the emulations in the page before printing find them done.
  const cleaned = (body: Buffer, contentType: string | undefined) => (clean ? cleanDocument(body, contentType, web.enableJavascript, rewrite ? (css) => rewriteCss(css, rewrite) : undefined) : undefined);
  let pageRequested = false;
  let pageNetwork = '';
  const post = postBody(load.post);
  const clientCert = clientCertOf(load);
  // The network ids of the requests a redirect took to another host than
  // the input's, and the page's main frame.
  const elsewhere = new Set<string>();
  let mainFrame = '';
  cdp.on('Fetch.requestPaused', (e: FetchPaused) => {
    handle(e).catch(() => cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {}));
  });
  const handle = async (e: FetchPaused) => {
    const { requestId, request } = e;
    const url = request.url;
    if (e.responseStatusCode !== undefined || e.responseErrorReason) {
      if (e.responseErrorReason) return cdp.send('Fetch.continueRequest', { requestId });
      // A document from the network, to clean: served from here when it
      // changes, or when Chromium would guess its encoding (guessed),
      // Chromium's response kept otherwise. Served from here, as a
      // rewritten style sheet, it tells neither its connection nor its
      // certificate (checkCertificate). A redirect has no body.
      if (e.resourceType === 'Document') {
        const status = e.responseStatusCode ?? 200;
        if (!clean || (status >= 300 && status < 400) || status === 204) return cdp.send('Fetch.continueRequest', { requestId });
        const type = e.responseHeaders?.find((h) => /^content-type$/i.test(h.name))?.value;
        const body = await cdp.send('Fetch.getResponseBody', { requestId });
        const c = cleaned(Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8'), type);
        if (!c?.changed && !c?.guessed) return cdp.send('Fetch.continueRequest', { requestId });
        const headers = (e.responseHeaders ?? []).filter((h) => !/^(content-length|content-encoding|content-type)$/i.test(h.name));
        headers.push({ name: 'Content-Type', value: c.contentType });
        return cdp.send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers, body: c.body.toString('base64') });
      }
      // A style sheet response, to rewrite.
      if (!rewrite) return cdp.send('Fetch.continueRequest', { requestId });
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
    // The page's own request, the first of its frame: --custom-header
    // without propagation and --post go with it alone, as in wkhtmltopdf. A
    // page given as a file takes neither, and they never go with a request
    // of one of its frames, which up to 1.3.0 took them after such a page.
    const pageRequest = !pageRequested && e.resourceType === 'Document' && e.frameId === mainFrame;
    if (pageRequest) {
      pageRequested = true;
      pageNetwork = e.networkId ?? '';
    }
    // A hop of the page's own request: the request itself, or a redirect it
    // followed, which shares its network id.
    const pageHop = pageRequest || (Boolean(pageNetwork) && e.networkId === pageNetwork);
    if (url.startsWith('file:')) return serveFile(e);
    if (!web.loadImages && e.resourceType === 'Image') {
      return cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
    if (e.resourceType === 'Font' && /^https?:/.test(url)) return relayFont(e);
    // --custom-header at each hop, as wkhtmltopdf sends it: Chromium drops
    // a header given here at a redirect.
    const headersHere = pageHop && load.customHeaders.length > 0 && !load.repeatCustomHeaders;
    const postHere = pageRequest && post !== null && /^https?:/.test(url);
    const main = headersHere || postHere;
    let headers: { name: string; value: string }[] | undefined;
    let postData: Buffer | undefined;
    if (main) {
      headers = ownHeaders(request.headers);
      if (headersHere) for (const [name, value] of load.customHeaders) headers.push({ name, value });
      if (postHere) {
        headers = headers.filter((h) => !/^content-(type|length)$/i.test(h.name));
        headers.push({ name: 'Content-Type', value: post.contentType });
        postData = post.body;
      }
    }
    // Called as pdfkiln, a request that another site sends to the input's
    // host by a redirect takes neither --header nor --cookie there, that
    // site having chosen it; the input's own request keeps them through its
    // redirects, a login on another site for instance, and that request
    // only: not a page the input then goes to (a meta refresh), nor a frame
    // loaded apart, whose address is the frame's (src/engine/frames.ts).
    const here = onInputHost(url);
    const sentHere = !spec.qtCookies && here && Boolean(e.networkId && elsewhere.has(e.networkId)) && !(spec.isMain && pageHop);
    if (e.networkId && !here && /^https?:/.test(url)) elsewhere.add(e.networkId);
    // The native --header: with every request to the page's host, in place
    // of the browser's own of the same name, and to no other host.
    const site = Boolean(spec.siteHeaders?.length) && here && !sentHere;
    if (site) {
      const names = new Set(spec.siteHeaders!.map(([name]) => name.toLowerCase()));
      headers = (headers ?? ownHeaders(request.headers)).filter((h) => !names.has(h.name.toLowerCase()));
      for (const [name, value] of spec.siteHeaders!) headers.push({ name, value });
    }
    // Chromium holds --cookie for the input's host and would add it: the
    // cookies it would send, but those, and none of SameSite Strict.
    if (sentHere && load.cookies.length && /^https?:/.test(spec.url)) {
      const { cookies } = await cdp.send('Network.getCookies', { urls: [url] });
      const given = new Set(load.cookies.map(([name, value]) => `${name}=${value}`));
      const kept = cookies.filter((c) => !given.has(`${c.name}=${c.value}`) && c.sameSite !== 'Strict').sort((a, b) => b.path.length - a.path.length);
      headers = (headers ?? ownHeaders(request.headers)).filter((h) => !/^cookie$/i.test(h.name));
      headers.push({ name: 'Cookie', value: kept.map((c) => `${c.name}=${c.value}`).join('; ') });
    }
    // wkhtmltopdf's cookies, in place of those Chromium would send.
    const cookie = await qtCookie(e);
    if (cookie !== undefined) {
      headers = (headers ?? ownHeaders(request.headers)).filter((h) => !/^cookie$/i.test(h.name));
      headers.push({ name: 'Cookie', value: cookie });
    }
    // Chromium cannot be given a client certificate: the command makes
    // the request.
    if (clientCert && url.startsWith('https:')) return relayTls(e, headers, postData);
    // A document's response comes back here to be cleaned.
    const toClean = clean && e.resourceType === 'Document' && /^https?:/.test(url) ? { interceptResponse: true } : {};
    if (main || site) return cdp.send('Fetch.continueRequest', { requestId, headers, ...toClean, ...(postData ? { method: 'POST', postData: postData.toString('base64') } : {}) });
    if (rewrite && e.resourceType === 'Stylesheet') return cdp.send('Fetch.continueRequest', { requestId, headers, interceptResponse: true });
    return cdp.send('Fetch.continueRequest', { requestId, headers, ...toClean });
  };

  // The Cookie header wkhtmltopdf sends with a request (LoadSpec.qtCookies),
  // --cookie's too from a page that has no host; undefined to leave
  // Chromium's.
  const everywhere = (spec.site ?? spec.url).startsWith('file:') ? load.cookies : [];
  const qtCookie = async (e: FetchPaused): Promise<string | undefined> => {
    if (OWN_COOKIES.has(e.resourceType) && !(e.resourceType === 'XHR' && e.request.urlFragment === CREDENTIALS)) return undefined;
    return jarCookie(e.request.url);
  };
  const jarCookie = async (url: string): Promise<string | undefined> => {
    if (!spec.qtCookies || !/^https?:/.test(url)) return undefined;
    const { cookies } = await cdp.send('Network.getCookies', { urls: [url] });
    return spec.qtCookies.line(cookies, url, everywhere);
  };

  // The input's host, the only one the native --header and --cookie go to.
  const inputHost = URL.parse(spec.site ?? spec.url)?.hostname;
  const onInputHost = (url: string) => Boolean(inputHost) && URL.parse(url)?.hostname === inputHost;

  // A font is fetched here, where Chromium adds nothing: its headers for
  // its host only, as the page's other requests have them. wkhtmltopdf's
  // cookies; called as pdfkiln, on the input's host, the cookies Chromium
  // holds for it, the longest path first, and the native --header.
  const fontHeaders = async (e: FetchPaused): Promise<Record<string, string>> => {
    if (spec.qtCookies) {
      const cookie = await qtCookie(e);
      return cookie ? { cookie } : {};
    }
    const url = e.request.url;
    if (!onInputHost(url)) return {};
    const { cookies } = await cdp.send('Network.getCookies', { urls: [url] });
    const h: Record<string, string> = {};
    if (cookies.length) h.cookie = cookies.sort((a, b) => b.path.length - a.path.length).map((c) => `${c.name}=${c.value}`).join('; ');
    for (const [name, value] of spec.siteHeaders ?? []) h[name] = value;
    return h;
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
    // A page or a frame, cleaned, with the charset it was read in: Chromium
    // then reads it so, where it would guess one for a page that declares
    // none.
    const c = e.resourceType === 'Document' ? cleaned(body, type) : undefined;
    if (c) {
      body = c.body;
      type = c.contentType;
    }
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
    for (const { name, value } of headers ?? ownHeaders(request.headers)) {
      if (!/^accept-encoding$/i.test(name)) h[name] = value;
    }
    // The Cookie line is Chromium's, already there at this stage; none
    // where it sends none (an XMLHttpRequest without credentials, a fetch
    // that omits them), measured with Chromium 158.
    h['Accept-Encoding'] = 'identity';
    const sent = body ?? (request.postDataEntries?.length ? Buffer.concat(request.postDataEntries.map((p) => Buffer.from(p.bytes ?? '', 'base64'))) : undefined);
    try {
      // As Chromium would: through its proxy, and with --username and
      // --password for a server that asks.
      const r = await relayRequest(request.url, {
        block: spec.blockPrivateNetwork,
        method: body ? 'POST' : request.method,
        headers: h,
        body: sent,
        proxy: spec.proxy,
        login: load.username ? { user: load.username, password: load.password } : undefined,
        tls: clientCert,
        insecure: spec.ignoreCertificateErrors,
        untrusted: sslErrorIgnored,
      });
      const responseHeaders = r.headers
        .filter(([k]) => !/^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i.test(k))
        .map(([name, value]) => ({ name, value }));
      if (r.status >= 400 && !isReport(e.resourceType)) fail(request.url, qtErrorForHttpStatus(r.status), r.status, qtErrorString(qtErrorForHttpStatus(r.status), request.url, r.status, r.statusText), r.status);
      let data = r.body;
      const c = e.resourceType === 'Document' && r.status < 300 ? cleaned(data, r.headers.find(([k]) => /^content-type$/i.test(k))?.[1]) : undefined;
      if (c?.changed || c?.guessed) {
        data = c.body;
        const at = responseHeaders.findIndex((h) => /^content-type$/i.test(h.name));
        if (at !== -1) responseHeaders.splice(at, 1);
        responseHeaders.push({ name: 'Content-Type', value: c.contentType });
      }
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
    const hostHeaders = await fontHeaders(e);
    if (e.networkId) answered.add(e.networkId);
    try {
      // As the page's other requests: through Chromium's proxy, with the
      // headers of --custom-header-propagation, and --username and
      // --password for a server that asks.
      const r = await relayGet(request.url, {
        block: spec.blockPrivateNetwork,
        headers: { 'user-agent': request.headers['User-Agent'] ?? '', ...(load.repeatCustomHeaders ? Object.fromEntries(load.customHeaders) : {}) },
        hostHeaders,
        // wkhtmltopdf's cookies at each hop of a redirect, as for its other
        // requests. Called as pdfkiln, none: a font another host sends to
        // the input's host takes neither --header nor --cookie there, that
        // host's request being chosen by another site.
        hostHeadersFor: spec.qtCookies ? async (url: string): Promise<Record<string, string>> => {
          const cookie = await jarCookie(url);
          return cookie ? { cookie } : {};
        } : undefined,
        proxy: spec.proxy,
        login: load.username ? { user: load.username, password: load.password } : undefined,
        tls: clientCert,
        insecure: spec.ignoreCertificateErrors,
        untrusted: sslErrorIgnored,
      });
      const headers = r.headers
        .filter(([k]) => !/^(access-control-allow-origin|content-encoding|content-length|transfer-encoding|connection)$/i.test(k))
        .map(([name, value]) => ({ name, value }));
      headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      if (r.status >= 400) fail(request.url, qtErrorForHttpStatus(r.status), r.status, qtErrorString(qtErrorForHttpStatus(r.status), request.url, r.status, r.statusText), r.status);
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: r.status, responseHeaders: headers, body: r.body.toString('base64') });
    } catch (err) {
      // A refused certificate fails as Chromium's do: the handshake.
      const ns = (err as { code?: string }).code === 'ENOTFOUND' ? 3 : err instanceof CertificateError ? 6 : 99;
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

  // --debug-javascript: what the page's scripts write to the console, and
  // their errors, as warnings, as wkhtmltopdf printed them: the address and
  // the line, then the message, for the page and for its header and footer
  // pages (measured on 0.12.6), and for a frame printed apart, whose
  // console the page's session does not hear. The line is the message's
  // own, where wkhtmltopdf's WebKit gave 1, and an error is told in
  // Chromium's words.
  if (load.debugJavascript) {
    const where = (url?: string, line?: number) => (url ? `${url}:${(line ?? 0) + 1}` : 'undefined:0');
    // Its first argument, as JavaScript writes it, of console.log, info,
    // warn, error and debug: wkhtmltopdf 0.12.6 printed no other.
    const SHOWN = new Set(['log', 'info', 'warning', 'error', 'debug']);
    cdp.on('Runtime.consoleAPICalled', (e: { type: string; args: { type: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string }[]; stackTrace?: { callFrames: { url: string; lineNumber: number }[] } }) => {
      if (!SHOWN.has(e.type)) return;
      const at = e.stackTrace?.callFrames[0];
      const a = e.args[0];
      const text = !a || a.type === 'undefined' ? 'undefined'
        : a.value !== undefined ? String(a.value)
        : a.unserializableValue ?? (a.type === 'object' && a.subtype !== 'array' ? '[object Object]' : a.description ?? '');
      out.warning(`${at?.url ?? ''}:${(at?.lineNumber ?? 0) + 1} ${text}`);
    });
    cdp.on('Runtime.exceptionThrown', (e: { exceptionDetails: { text: string; url?: string; lineNumber?: number; exception?: { value?: unknown; description?: string } } }) => {
      const d = e.exceptionDetails;
      const what = d.exception?.description ?? (d.exception?.value !== undefined ? `${d.text} ${String(d.exception.value)}` : d.text);
      out.warning(`${where(d.url, d.lineNumber)} ${what.split('\n')[0]}`);
    });
  }

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
    cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.max(1, Math.round(spec.viewport.width)), height: Math.max(1, Math.round(spec.viewport.height)), deviceScaleFactor: spec.viewport.scale ?? 1, mobile: false }),
    web.enableJavascript ? undefined : cdp.send('Emulation.setScriptExecutionDisabled', { value: true }),
    load.repeatCustomHeaders && load.customHeaders.length
      ? cdp.send('Network.setExtraHTTPHeaders', { headers: Object.fromEntries(load.customHeaders) })
      : undefined,
    spec.fontFamilies ? cdp.send('Page.setFontFamilies', { fontFamilies: spec.fontFamilies }) : undefined,
    cdp.send('Runtime.addBinding', { name: '__pdfkilnPrint' }),
    spec.qtCookies ? cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MARK_CREDENTIALS }) : undefined,
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
  mainFrame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  const cookieUrl = spec.site ?? spec.url;
  if (load.cookies.length && /^https?:/.test(cookieUrl)) {
    await cdp.send('Network.setCookies', {
      cookies: load.cookies.map(([name, value]) => ({ name, value, url: cookieUrl })),
    });
    spec.qtCookies?.gave(load.cookies, URL.parse(cookieUrl)?.hostname ?? '');
  }

  // Load, then run-script, then window-status, then the delay. A page
  // given as a data: URL, which Chromium reads without the Fetch domain,
  // is cleaned here.
  const target = clean && /^[\t\n\f\r ]*data:/i.test(spec.url) ? cleanDataUrl(spec.url, 'document', { scripting: web.enableJavascript, depth: 0 }) ?? spec.url : spec.url;
  try {
    lp.status = (await page.goto(target, { waitUntil: 'load', timeout: 0, referer: spec.referer }))?.status() ?? 0;
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
  // The user style sheet, first in each frame: its text, or a link that
  // Chromium loads as any other style sheet, the wait ending once it has
  // loaded or failed. Its text ranks as WebKit ranks a user style sheet, in
  // a cascade layer of its own (userLayer), rewritten for the emulations
  // as a served style sheet is, before the layer, which WebKit 534 did not
  // know: what it holds is the sheet's. A page whose Content-Security-Policy
  // refuses inline styles leaves the element without its style sheet: it
  // is then adopted, which the policy does not govern, without its @import
  // rules. The policy stays in force for the page.
  if (spec.userStyleSheet || spec.userStyleSheetUrl) {
    const css = spec.userStyleSheet ? userLayer(spec.emulation ? rewriteCss(spec.userStyleSheet, spec.emulation) : spec.userStyleSheet) : '';
    await Promise.all(documentFrames(page).map((f) => f.evaluate((css: string, href: string) => new Promise<void>((done) => {
      const at = document.head ?? document.documentElement;
      if (!href) {
        const s = document.createElement('style');
        s.textContent = css;
        at.prepend(s);
        if (!s.sheet) {
          s.remove();
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          document.adoptedStyleSheets = [sheet, ...document.adoptedStyleSheets];
        }
        return done();
      }
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = l.onerror = () => done();
      at.prepend(l);
    }), css, spec.userStyleSheetUrl ?? '').catch(() => {})));
  }
  // The native --css: last in the page, it wins over the page's own rules
  // (@page included). A page whose Content-Security-Policy refuses inline
  // styles leaves the element without its style sheet (measured, Chromium
  // 158): the style sheet is then adopted, which the policy does not
  // govern, after the page's own all the same, but without @import rules.
  // The policy stays in force for the page.
  if (spec.css) {
    await page.evaluate((css: string) => {
      const s = document.createElement('style');
      s.textContent = css;
      document.documentElement.append(s);
      if (s.sheet) return;
      s.remove();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
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
      const r = await cdp.send('Runtime.evaluate', { expression: js, userGesture: true }).catch(() => undefined);
      // Its error, with --debug-javascript, as the page's are told.
      const d = r?.exceptionDetails;
      if (d && load.debugJavascript) out.warning(`undefined:0 ${(d.exception?.description ?? d.text).split('\n')[0]}`);
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
  lp.resize = async (width, height) => {
    const wait = load.jsdelay > 0 && !lp.printRequested;
    // The window's resize event comes with the next frame drawn after the
    // override, which headless Chromium on macOS may draw after settle's
    // 20 ms of quiet (CI, macOS 15, Chromium 158): the page's scripts then
    // missed the new size. A listener set up first, after the page's own,
    // is waited for, up to the delay; then the page settles.
    if (wait) {
      await page.evaluate(() => {
        Object.defineProperty(window, '__pdfkilnResized', { configurable: true, value: new Promise<void>((done) => addEventListener('resize', () => done(), { once: true })) });
      }).catch(() => {});
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), deviceScaleFactor: spec.viewport.scale ?? 1, mobile: false });
    if (!wait) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      page.evaluate(() => (window as unknown as { __pdfkilnResized?: Promise<void> }).__pdfkilnResized).catch(() => {}),
      new Promise<void>((r) => { timer = setTimeout(r, load.jsdelay); }),
    ]);
    clearTimeout(timer);
    await settle(page, inflight, load.jsdelay);
  };
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
    for (const f of documentFrames(page)) {
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
  await Promise.all(documentFrames(lp.page).map((f) => f.evaluate(emulateInPage, e).catch(() => {})));
}

interface FetchPaused {
  requestId: string;
  request: { url: string; urlFragment?: string; method: string; headers: Record<string, string>; postDataEntries?: { bytes?: string }[] };
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
