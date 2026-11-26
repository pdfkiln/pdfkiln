// The compatible command end to end, with Chromium: what the libraries
// rely on (exit codes, stderr, standard input and output), what the
// specification promises (objects, numbering, headers), and the security
// rules. Needs the pinned Chromium (npm run fetch:chromium) and an
// unprivileged user: the sandbox stays on. Text checks use PyMuPDF
// (bench/requirements.txt) and are skipped without it.
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { launch } from '../src/engine/browser.js';
import { qtFamilies } from '../src/engine/fonts.js';
import { version } from '../src/version.js';

const root = resolve(import.meta.dirname, '..', '..');
// PDFKILN_TEST_BUNDLE=1: the bundled command. PDFKILN_TEST_WKHTMLTOPDF,
// PDFKILN_TEST_WKHTMLTOIMAGE and PDFKILN_TEST_PDFKILN: the programs of a
// package (the single executable, its links or the Windows launcher).
const bundled = Boolean(process.env.PDFKILN_TEST_BUNDLE);
const cli = bundled ? join(root, 'dist', 'bundle', 'wkhtmltopdf.cjs') : join(root, 'dist', 'src', 'bin', 'wkhtmltopdf.js');
const command = (exe: string | undefined, script: string, args: string[]): [string, string[]] =>
  exe ? [exe, args] : [process.execPath, [script, ...args]];
const dir = mkdtempSync(join(tmpdir(), 'pdfkiln-test-'));
const python = process.env.PDFKILN_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const hasPyMuPDF = (() => {
  try {
    execFileSync(python, ['-I', '-c', 'import pymupdf'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface Run { code: number | null; stdout: Buffer; stderr: string; ms: number }

// opts.sh: shell commands run first, by a shell that then becomes the command.
function run(args: string[], opts: { stdin?: string | Buffer; cwd?: string; env?: NodeJS.ProcessEnv; sh?: string } = {}): Promise<Run> {
  return new Promise((ok) => {
    const t0 = performance.now();
    const env = { ...process.env, ...opts.env };
    delete env.NODE_EXTRA_CA_CERTS;
    const [exe, argv] = command(process.env.PDFKILN_TEST_WKHTMLTOPDF, cli, args);
    const child = opts.sh
      ? spawn('/bin/sh', ['-c', `${opts.sh}; exec "$0" "$@"`, exe, ...argv], { cwd: opts.cwd ?? dir, env })
      : spawn(exe, argv, { cwd: opts.cwd ?? dir, env });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => ok({ code, stdout: Buffer.concat(out), stderr: err, ms: performance.now() - t0 }));
    child.stdin.end(opts.stdin ?? '');
  });
}

// Text of each page, with PyMuPDF.
function pagesText(file: string): string[] {
  const script = 'import sys, json, pymupdf\nd = pymupdf.open(sys.argv[1])\nprint(json.dumps([p.get_text() for p in d]))';
  return JSON.parse(execFileSync(python, ['-I', '-c', script, file], { encoding: 'utf8' }));
}

// The text blocks of the first page ([x0, y0, x1, y1, text], from the top)
// and the addresses its links go to, with PyMuPDF.
function firstPage(file: string): { blocks: [number, number, number, number, string][]; links: string[] } {
  const script = 'import sys, json, pymupdf\np = pymupdf.open(sys.argv[1])[0]\nprint(json.dumps({"blocks": [b[:5] for b in p.get_text("blocks")], "links": [l.get("uri", "") for l in p.get_links()]}))';
  return JSON.parse(execFileSync(python, ['-I', '-c', script, file], { encoding: 'utf8' }));
}
// A page given as a file, which holds a frame of another origin.
const framePage = (name: string) => file(name, `<p>Before</p><iframe src="${other}/frame/red" width="400" height="200" style="border: 3px solid #000"></iframe><p>After</p>`);
// The frame's text on the first page, between the page's own, inside the
// frame's border; and the frame's link.
function assertFramePrinted(pdf: string): void {
  const { blocks, links } = firstPage(pdf);
  const at = (s: string) => blocks.find((b) => b[4].includes(s));
  const [before, frame, after] = [at('Before'), at('FRAME TEXT'), at('After')];
  assert.ok(before && frame && after, JSON.stringify(blocks));
  assert.ok(before[3] <= frame[1] && frame[3] <= after[1], JSON.stringify(blocks));
  assert.ok(frame[0] > before[0], JSON.stringify(blocks));
  assert.ok(links.includes('https://example.com/in-frame'), JSON.stringify(links));
}

const lastLine = (s: string) => s.trim().split(/[\r\n]+/).pop();
const file = (name: string, content: string) => {
  const p = join(dir, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

// What --pdfa and --factur-x leave in a PDF: the PDF/A part and level its XMP
// declares, and its associated files, each with its relationship.
const invoiceXml = join(root, 'test', 'fixtures', 'invoice-minimum.xml');
async function archived(f: string): Promise<{ part?: string; conformance?: string; files: string[] }> {
  const doc = await PDFDocument.load(readFileSync(f), { updateMetadata: false });
  const meta = doc.catalog.lookupMaybe(PDFName.of('Metadata'), PDFStream);
  const xmp = meta instanceof PDFRawStream ? Buffer.from(meta.contents).toString('utf8') : '';
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  const files: string[] = [];
  for (let i = 0; af && i < af.size(); i++) {
    const spec = doc.context.lookup(af.get(i), PDFDict);
    const name = spec.lookup(PDFName.of('UF')) ?? spec.lookup(PDFName.of('F'));
    files.push(`${name instanceof PDFString || name instanceof PDFHexString ? name.decodeText() : String(name)} ${String(spec.lookup(PDFName.of('AFRelationship')))}`);
  }
  return { part: /<pdfaid:part>(\d)</.exec(xmp)?.[1], conformance: /<pdfaid:conformance>(\w)</.exec(xmp)?.[1], files };
}

let server: Server;
let base = '';
// The same server under another origin.
let other = '';
let hangs: (() => void)[] = [];
// X-Test as the last /img request carried it.
let imgHeader = '';
// And its Cookie.
let imgCookie = '';
// The Cookie of the last /show-cookie request.
let shownCookie = '';
// The Cookie of each /seen/ request, by host and path.
const seenCookies = new Map<string, string>();
// The X-Test and Cookie of each /font/ request, by host and path.
const fontRequests = new Map<string, string>();
// The Cookie and Content-Language of each /xhr/ request, by path.
const xhrRequests = new Map<string, string>();
// Each /login/ path, "authorized" once it was.
const loginRequests = new Map<string, string>();
// X-Test and Cookie of the last /page-home request.
let pageRequest = '';
// The Referer of the last /ref-seen request, the X-Test of the last
// /refresh-landing and the X-Custom of the last /hop-landing.
let refSeen = '';
let landingHeader = '';
let hopHeader = '';
// The method, X-Test and Cookie of each /frame/red request.
const frameRequests: string[] = [];
// The challenge of /login/digest.woff, and the check of its answer for
// user:pass (RFC 2617, qop auth).
const REALM = 'pdfkiln';
const NONCE = 'n0nce';
function digestOk(h: string | undefined, method: string): boolean {
  if (!h?.startsWith('Digest ')) return false;
  const p = Object.fromEntries([...h.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1]!, m[2] ?? m[3] ?? '']));
  const md5 = (s: string) => createHash('md5').update(s).digest('hex');
  const ha1 = md5(`user:${REALM}:pass`);
  const ha2 = md5(`${method}:${p.uri}`);
  return p.username === 'user' && p.realm === REALM && p.nonce === NONCE && p.qop === 'auth' && p.response === md5(`${ha1}:${NONCE}:${p.nc}:${p.cnonce}:auth:${ha2}`);
}
// Pipes a connection to a port of 127.0.0.1, head first.
function tunnelTo(client: Socket, port: number, head: Buffer): void {
  client.pause();
  const up = connectTcp(port, '127.0.0.1', () => {
    up.write(head);
    client.pipe(up);
    up.pipe(client);
  });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
}
// The Cookie and X-Test of the last /user.css request.
let userCssRequest = '';
// X-Test and Cookie of the last /md/doc.md request, and of its image.
let mdRequest = '';
let mdImageRequest = '';
// What /terms.pdf serves.
let servedPdf: Buffer = Buffer.alloc(0);
before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const html = (body: string, status = 200) => res.writeHead(status, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
    if (path === '/ok') return html('<h1>Hello</h1>');
    if (path === '/set-cookie') return res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'secret=1; Path=/' }).end('<p>set</p>');
    if (path === '/show-cookie') {
      shownCookie = String(req.headers.cookie ?? 'none');
      return html(`<p>Cookie: ${shownCookie}</p>`);
    }
    if (path?.startsWith('/seen/')) {
      seenCookies.set(`${(req.headers.host ?? '').replace(/:\d+$/, '')}${path}`, String(req.headers.cookie ?? 'none'));
      if (path === '/seen/page') return html(seenPage());
      // A script that sets a cookie, then asks for an image.
      if (path === '/seen/set.js') {
        return res.writeHead(200, { 'content-type': 'text/javascript', 'set-cookie': 'srv=1; Path=/' }).end(`document.write('<img src="${base}/seen/after.svg">');`);
      }
      if (path.endsWith('.css')) return res.writeHead(200, { 'content-type': 'text/css' }).end('p { color: blue }');
      return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    }
    // Fonts of the page's host, of another, and of its host moved to the
    // other; the page sets a cookie for them.
    if (path === '/fonts') {
      return res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'srv=1; Path=/font' })
        .end(`<!doctype html><style>@font-face { font-family: A; src: url(/font/a.woff) } @font-face { font-family: B; src: url(${other}/font/b.woff) }
        @font-face { font-family: C; src: url(/font/moved) } .a { font-family: A } .b { font-family: B } .c { font-family: C }</style>
        <p class="a">a</p><p class="b">b</p><p class="c">c</p>`);
    }
    // Fonts behind a login, Basic and Digest, in a page behind Basic.
    if (path?.startsWith('/login/')) {
      const digest = path === '/login/digest.woff';
      const ok = digest ? digestOk(req.headers.authorization, req.method ?? 'GET') : req.headers.authorization === `Basic ${Buffer.from('user:pass').toString('base64')}`;
      if (!ok) {
        loginRequests.set(path, loginRequests.get(path) ?? '401');
        return res.writeHead(401, { 'www-authenticate': digest ? `Digest realm="${REALM}", nonce="${NONCE}", qop="auth", algorithm=MD5` : 'Basic realm="pdfkiln"' }).end();
      }
      loginRequests.set(path, 'authorized');
      if (path === '/login/page') {
        return html(`<style>@font-face { font-family: B; src: url(/login/basic.woff) } @font-face { font-family: D; src: url(/login/digest.woff) }
          .b { font-family: B } .d { font-family: D }</style><p class="b">basic</p><p class="d">digest</p>`);
      }
      return res.writeHead(200, { 'content-type': 'font/woff' }).end();
    }
    // Fonts for a page behind a proxy: of its host, over https on the port
    // ?tls= gives, and of localhost, which goes around the proxy.
    if (path === '/proxied-fonts') {
      const tls = new URL(req.url ?? '', base).searchParams.get('tls');
      return html(`<style>@font-face { font-family: P; src: url(/font/p.woff) } @font-face { font-family: S; src: url(https://pdfkiln-proxied.invalid:${tls}/font) }
        @font-face { font-family: L; src: url(${other}/font/l.woff) } .p { font-family: P } .s { font-family: S } .l { font-family: L }</style>
        <p class="p">p</p><p class="s">s</p><p class="l">l</p>`);
    }
    if (path?.startsWith('/xhr/')) {
      xhrRequests.set(path, `${req.headers.cookie ?? 'none'}, ${req.headers['content-language'] ?? 'none'}`);
      return res.writeHead(200, { 'content-type': 'text/plain' }).end('x');
    }
    if (path === '/xhr-page') return html(xhrPage());
    // A font of another host, moved to the page's.
    if (path === '/fonts-back') return html(`<style>@font-face { font-family: H; src: url(${other}/font/back) } p { font-family: H }</style><p>h</p>`);
    if (path?.startsWith('/font/')) {
      fontRequests.set(`${(req.headers.host ?? '').replace(/:\d+$/, '')}${path}`, `${req.headers['x-test'] ?? 'no header'}, ${req.headers.cookie ?? 'no cookie'}`);
      if (path === '/font/moved') return res.writeHead(302, { location: `${other}/font/c.woff` }).end();
      if (path === '/font/back') return res.writeHead(302, { location: `${base}/font/home.woff` }).end();
      return res.writeHead(200, { 'content-type': 'font/woff' }).end();
    }
    if (path === '/post') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => html(`<p>${req.method} ${(req.headers['content-type'] ?? '').split(';')[0]}</p><pre>${body.replace(/</g, '&lt;').replace(/&(?!lt;)/g, '&amp;')}</pre>`));
      return;
    }
    if (path === '/404') return html('missing', 404);
    if (path === '/css404') return html('<link rel="stylesheet" href="/nope.css">styled');
    // What Chromium sends and wkhtmltopdf's WebKit did not: CSP reports, one
    // answered as google.com answers them (204, text/html, nosniff: ORB
    // blocks it), one unreachable, and a beacon. And what it keeps from the
    // page: HTML for an image (ORB), a response without CORS headers.
    if (path === '/extras') {
      return res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy-report-only': `script-src 'none'; report-uri ${other}/report http://pdfkiln-nonexistent.invalid/report` })
        .end(`<p>extras</p><img src="${other}/ok"><script>navigator.sendBeacon('http://pdfkiln-nonexistent.invalid/beacon', 'x'); fetch('${other}/ok').catch(() => {});</script>`);
    }
    if (path === '/report') return res.writeHead(204, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' }).end();
    // The same, in 404: HTML for an image, a request without CORS headers.
    if (path === '/withheld404') return html(`<img src="${other}/404">`);
    if (path === '/cors404') return html(`<script>const x = new XMLHttpRequest(); x.open('GET', '${other}/404'); x.send();</script>`);
    // The same image, blocked by the page's CSP before it is sent.
    if (path === '/csp404') return res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "img-src 'self'" }).end(`<p>csp</p><img src="${other}/404">`);
    // A page whose resources the last line answers in 404, and a page that
    // asks for a password.
    if (path === '/resources') {
      return html(`<style>@font-face { font-family: F; src: url(/font) } p { font-family: F }</style><p>resources</p>
        <img src="/image"><img src="/image.png"><link rel="stylesheet" href="/style.css"><iframe src="/frame"></iframe>
        <script>const x = new XMLHttpRequest(); x.open('GET', '/data'); x.send();</script>`);
    }
    if (path === '/auth') {
      if (req.headers.authorization === `Basic ${Buffer.from('user:pass').toString('base64')}`) return html('<p>authorized</p>');
      return res.writeHead(401, { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="pdfkiln"' }).end('<p>auth</p>');
    }
    if (path === '/headers') return html(`<p>X-Test=${req.headers['x-test'] ?? 'none'}</p><img src="/img">`);
    // An image of another host moved to this one, and a page that goes
    // through another host before it comes back.
    if (path === '/headers-back') return html(`<img src="${other}/img-back">`);
    if (path === '/img-back') return res.writeHead(302, { location: `${base}/img` }).end();
    if (path === '/page-out') return res.writeHead(302, { location: `${other}/page-hop` }).end();
    if (path === '/page-hop') return res.writeHead(302, { location: `${base}/page-home` }).end();
    if (path === '/page-home') {
      pageRequest = `${req.headers['x-test'] ?? 'no header'}, ${req.headers.cookie ?? 'no cookie'}`;
      return html('<p>home</p><img src="/img">');
    }
    // Markdown on the web: a document, its image beside it, a redirect to
    // it, and one without a name.
    const seen = () => `${req.headers['x-test'] ?? 'no header'}, ${req.headers.cookie ?? 'no cookie'}`;
    if (path === '/md/doc.md') {
      mdRequest = seen();
      return res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        .end('---\ntitle: From the web\n---\n# Remote\n\n![logo](img/logo.svg) [install](doc.md#install) [web](https://example.com/)\n\n## Install\n');
    }
    if (path === '/md/img/logo.svg') {
      mdImageRequest = seen();
      return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    }
    if (path === '/md/moved.md') return res.writeHead(302, { location: '/md/doc.md' }).end();
    if (path === '/md/raw-readme') return res.writeHead(200, { 'content-type': 'text/plain' }).end('# Raw readme\n');
    if (path === '/user.css') {
      userCssRequest = `${req.headers.cookie ?? 'no cookie'}, ${req.headers['x-test'] ?? 'no header'}`;
      return res.writeHead(200, { 'content-type': 'text/css' }).end('h1 { height: 2000px }');
    }
    // A page whose Content-Security-Policy refuses inline styles, its own
    // included, as many sites' does.
    if (path === '/csp') {
      return res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "style-src 'self'" })
        .end('<!doctype html><title>T</title><style>p { display: none }</style><p>shown: the page\'s inline style is refused</p>');
    }
    // A page that colours its lines in red, from a style sheet of its own
    // origin, with or without such a policy; a style sheet for a user style
    // sheet to import.
    if (path === '/rank' || path === '/rank-csp') {
      const lines = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((c) => `<p class="${c.toLowerCase()}">${c}</p>`).join('');
      return res.writeHead(200, { 'content-type': 'text/html', ...(path === '/rank-csp' ? { 'content-security-policy': "style-src 'self'" } : {}) })
        .end(`<!doctype html><title>T</title><link rel="stylesheet" href="/rank/page.css">${lines}`);
    }
    if (path === '/rank/page.css') return res.writeHead(200, { 'content-type': 'text/css' }).end('.c1, .c2, .c3 { color: #ff0000 } .c4 { color: #ff0000 !important }');
    if (path === '/rank/imported.css') return res.writeHead(200, { 'content-type': 'text/css' }).end('.c6 { color: #0000ff }');
    // The pages of two page-break tests of WebKit 534 (a table row that does
    // not fit, a paragraph's first line alone at the bottom), under such a
    // policy: their style from a style sheet of their own origin.
    if (path === '/csp-breaks/rows' || path === '/csp-breaks/orphan') {
      const body = path.endsWith('/rows')
        ? `<div class="gap-rows"></div><table>${Array.from({ length: 6 }, (_, i) => `<tr><td><div class="row">R${i + 1}</div></td></tr>`).join('')}</table>`
        : `<div class="gap-orphan"></div><p>${Array.from({ length: 4 }, (_, i) => `L${i + 1} ${'word '.repeat(30)}`).join('<br>')}</p>`;
      return res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "style-src 'self'" })
        .end(`<link rel="stylesheet" href="/csp-breaks/page.css">${body}`);
    }
    if (path === '/csp-breaks/page.css') {
      return res.writeHead(200, { 'content-type': 'text/css' }).end('body{margin:0;font:16px/20px sans-serif} p{margin:0} '
        + 'table{border-collapse:collapse;width:100%} td{border:1px solid;padding:10px} .row{height:150px} .gap-rows{height:115px} .gap-orphan{height:1285px}');
    }
    if (path === '/img') imgHeader = String(req.headers['x-test'] ?? 'none');
    if (path === '/img') imgCookie = String(req.headers.cookie ?? 'none');
    if (path === '/third-party') return html(`<img src="${other}/img">`);
    if (path === '/img') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text y="10">${req.headers['x-test'] ?? 'none'}</text></svg>`);
    // An image and a frame that wait to be scrolled to, far below the window.
    if (path === '/terms.pdf') return res.writeHead(200, { 'content-type': 'application/pdf' }).end(servedPdf);
    if (path === '/fake.pdf') return html('<p>not a PDF</p>');
    if (path === '/deferred') {
      return html('<style>body { margin: 0 } div { height: 8000px }</style><div></div><img loading="lazy" src="/deferred/green.svg" width="200" height="200" style="display: block"><iframe loading="lazy" src="/deferred/green.html" width="200" height="200" style="display: block; border: 0"></iframe>');
    }
    if (path === '/deferred/green.svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#0f0"/></svg>');
    if (path === '/deferred/green.html') return html('<style>body { margin: 0; background: #0f0 }</style>');
    // Deferred frames that load no document: a 204, a download.
    if (path === '/deferred-empty') return html('<div style="height: 8000px"></div><iframe loading="lazy" src="/no-content"></iframe><iframe loading="lazy" src="/attachment"></iframe>');
    if (path === '/no-content') return res.writeHead(204).end();
    if (path === '/attachment') return res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' }).end('x');
    // A frame for a page of another origin: red, with a link; and a page
    // whose frame of another site lies below the window.
    if (path === '/frame/red') {
      frameRequests.push(`${req.method} ${req.headers['x-test'] ?? 'no header'}, ${req.headers.cookie ?? 'no cookie'}`);
      return html('<style>body { margin: 0; background: #c00 } p { margin: 0; font: 30px sans-serif; color: #fff }</style><p>FRAME TEXT</p><a href="https://example.com/in-frame" style="color: #fff">in frame</a>');
    }
    if (path === '/frame/empty') return html('<html><body></body></html>');
    // A header page of the web.
    if (path === '/web-header') return html('<!DOCTYPE html><p style="font: 12px sans-serif; margin: 0">WEB HEADER</p>');
    // An image of the input's host that goes to another site; a page that
    // goes to another site, which sends it back; a page that redirects.
    if (path === '/ref-page') return html('<p>ref</p><img src="/ref-hop">');
    if (path === '/ref-hop') return res.writeHead(302, { location: `${other}/ref-seen` }).end();
    if (path === '/ref-seen') {
      refSeen = String(req.headers.referer ?? 'none');
      return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    }
    if (path === '/refresh') return html(`<meta http-equiv="refresh" content="0;url=${other}/refresh-back"><p>wait</p>`);
    if (path === '/refresh-back') return res.writeHead(302, { location: `${base}/refresh-landing` }).end();
    if (path === '/refresh-landing') {
      landingHeader = String(req.headers['x-test'] ?? 'no header');
      return html('<p>landed</p>');
    }
    if (path === '/hop-start') return res.writeHead(302, { location: '/hop-landing' }).end();
    if (path === '/hop-landing') {
      hopHeader = String(req.headers['x-custom'] ?? 'none');
      return html('<p>hop</p>');
    }
    // Another site sends this frame to the input's host.
    if (path === '/frame/redirect') return res.writeHead(302, { location: `${base}/frame/red` }).end();
    if (path === '/frame-below-redirect') {
      return html(`<style>body { margin: 0 }</style><div style="height: 2000px"></div><iframe src="${other}/frame/redirect" width="400" height="200" style="display: block; border: 0"></iframe><div style="height: 300px"></div>`);
    }
    if (path === '/frame-below') {
      return html(`<style>body { margin: 0 }</style><div style="height: 2000px"></div><iframe src="${other}/frame/red" width="400" height="200" style="display: block; border: 0"></iframe><div style="height: 300px"></div>`);
    }
    if (path === '/hang') {
      hangs.push(() => res.end());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  other = base.replace('127.0.0.1', 'localhost');
});
// Style sheets and an image on two sites, 127.0.0.1 and localhost.
const seenPage = () => `<link rel="stylesheet" href="${base}/seen/a.css"><link rel="stylesheet" href="${base}/seen/sub/b.css">
  <link rel="stylesheet" href="${other}/seen/c.css"><img src="${base}/seen/d.svg"><p>seen</p>`;
// XMLHttpRequests to 127.0.0.1, withCredentials set after open(): one
// synchronous with a header, one asynchronous, and one without it.
const xhrPage = () => `<p>xhr</p><script>
  const send = (name, credentials, async) => {
    const x = new XMLHttpRequest();
    x.open('GET', '${base}/xhr/' + name, async);
    if (name === 'sync') x.setRequestHeader('Content-Language', 'fr');
    x.withCredentials = credentials;
    try { x.send(); } catch (e) {}
  };
  send('sync', true, false); send('async', true, true); send('plain', false, false);
</script>`;
after(() => {
  for (const h of hangs) h();
  hangs = [];
  server.close();
  // Windows may hold a file of the last conversion a moment longer: EPERM
  // once on 19/11/2026, the folder removed a few minutes later.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// A server whose certificate is self-signed: a page, its image and its web
// font, each on a connection of its own (Connection: close), so that the
// warnings can be counted. Null without openssl.
async function selfSignedServer(): Promise<{ url: string; close: () => void } | null> {
  const d = mkdtempSync(join(dir, 'self-signed-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '2', '-subj', '/CN=localhost'], { cwd: d, stdio: 'ignore' });
  } catch {
    return null;
  }
  const tls = createHttpsServer({ key: readFileSync(join(d, 'k.pem')), cert: readFileSync(join(d, 'c.pem')) }, (req, res) => {
    res.setHeader('connection', 'close');
    if (req.url === '/image') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    if (req.url === '/font') return res.writeHead(200, { 'content-type': 'font/ttf' }).end('not a font');
    res.writeHead(200, { 'content-type': 'text/html' })
      .end('<title>T</title><style>@font-face { font-family: F; src: url(/font) } p { font-family: F }</style><p>self-signed</p><img src="/image">');
  });
  await new Promise<void>((ok) => tls.listen(0, '127.0.0.1', ok));
  return { url: `https://localhost:${(tls.address() as AddressInfo).port}/`, close: () => tls.close() };
}

// A test CA, a server certificate for localhost and a client certificate,
// "Kiln client", its key under the password "secret", made in d. Null
// without openssl.
function clientCerts(d: string): { key: Buffer; cert: Buffer; ca: Buffer; args: string[] } | null {
  mkdirSync(d, { recursive: true });
  const ossl = (...a: string[]) => execFileSync('openssl', a, { cwd: d, stdio: 'ignore' });
  try {
    ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Test CA');
    ossl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
    ossl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2');
    ossl('req', '-newkey', 'rsa:2048', '-passout', 'pass:secret', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=Kiln client');
    ossl('x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.crt', '-days', '2');
  } catch {
    return null;
  }
  return {
    key: readFileSync(join(d, 'server.key')),
    cert: readFileSync(join(d, 'server.crt')),
    ca: readFileSync(join(d, 'ca.crt')),
    args: ['--ssl-crt-path', join(d, 'client.crt'), '--ssl-key-path', join(d, 'client.key'), '--ssl-key-password', 'secret'],
  };
}

describe('interface', () => {
  test('--version', async () => {
    const r = await run(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^wkhtmltopdf 0\.12\.6 \(with patched qt\), pdfkiln /);
  });

  test('an unknown option: exit 1, message, usage', async () => {
    const r = await run(['--bogus', 'a.html', 'out.pdf']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Unknown long argument --bogus\n\nName:/);
  });

  test('standard input to standard output, quietly', async () => {
    const r = await run(['-q', '-', '-'], { stdin: '<p>From stdin</p>' });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout.subarray(0, 5).toString(), '%PDF-');
    const doc = await PDFDocument.load(r.stdout);
    assert.deepEqual(doc.getPage(0).getSize(), { width: 595, height: 842 });
  });

  test('phases on stderr, ending with Done', async () => {
    const r = await run([`${base}/ok`, join(dir, 'ok.pdf')]);
    assert.equal(r.code, 0);
    const lines = r.stderr.split(/[\r\n]+/).filter((l) => l.trim() && !l.startsWith('[')).map((l) => l.trimEnd());
    assert.deepEqual(lines, ['Loading pages (1/6)', 'Counting pages (2/6)', 'Resolving links (4/6)', 'Loading headers and footers (5/6)', 'Printing pages (6/6)', 'Done']);
    const doc = await PDFDocument.load(readFileSync(join(dir, 'ok.pdf')), { updateMetadata: false });
    assert.equal(doc.getTitle(), 'T');
    assert.ok(doc.catalog.get(PDFName.of('Outlines')), 'outline');
    // PDFKiln and its version, the Application field of viewers; not Chromium's.
    assert.deepEqual([doc.getCreator(), doc.getProducer()], [`PDFKiln ${version}`, 'pdfkiln.org']);
  });

  test('a 404 page: the PDF, and exit 1 as wkhtmltopdf 0.12.6', async () => {
    const out = join(dir, '404.pdf');
    const r = await run(['-q', `${base}/404`, out]);
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.stderr), 'Exit with code 1 due to network error: ContentNotFoundError');
    assert.ok(readFileSync(out).length > 0);
  });

  test('a missing style sheet is only a warning', async () => {
    const r = await run(['--log-level', 'warn', `${base}/css404`, join(dir, 'css.pdf')]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, `Warning: Failed to load ${base}/nope.css (ignore)\n`);
  });

  test('beacons, CSP reports and responses Chromium keeps from the page are not load errors', async () => {
    const r = await run(['--log-level', 'warn', `${base}/extras`, join(dir, 'extras.pdf')]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  test('a response Chromium keeps from the page fails as wkhtmltopdf 0.12.6 read it', async () => {
    let r = await run(['--log-level', 'warn', `${base}/withheld404`, join(dir, 'withheld.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `Error: Failed to load ${other}/404, with network status code 203 and http status code 404 - Error downloading ${other}/404 - server replied: Not Found\nExit with code 1 due to network error: ContentNotFoundError\n`);
    // Its WebKit canceled a response failing CORS once it had the status.
    r = await run(['--log-level', 'warn', `${base}/cors404`, join(dir, 'withheld.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `Error: Failed to load ${other}/404, with network status code 5 and http status code 404 - Operation canceled\nExit with code 1 due to network error: OperationCanceledError\n`);
  });

  test('the delay waits for the status of a response Chromium keeps, not for a request blocked before it is sent', async () => {
    // Against a page without a delay: Chromium's start is in both.
    const plain = await run(['-q', '--javascript-delay', '0', `${base}/ok`, join(dir, 'held.pdf')]);
    let r = await run(['-q', '--javascript-delay', '10000', `${base}/withheld404`, join(dir, 'held.pdf')]);
    assert.equal(r.code, 1);
    assert.ok(r.ms < plain.ms + 5000, `the status took ${Math.round(r.ms - plain.ms)} ms more`);
    r = await run(['--log-level', 'warn', '--javascript-delay', '10000', `${base}/csp404`, join(dir, 'held.pdf')]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.ok(r.ms < plain.ms + 5000, `an image blocked by the CSP held the page ${Math.round(r.ms - plain.ms)} ms more`);
  });

  test('an unknown host: exit 1, no PDF', async () => {
    const r = await run(['-q', 'http://pdfkiln-nonexistent.invalid/', join(dir, 'none.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.stderr), 'Exit with code 1 due to network error: HostNotFoundError');
  });

  // Odoo starts wkhtmltopdf under a soft cap on the address space, 2560 MiB
  // (limit_memory_hard), where wkhtmltopdf 0.12.6 runs and Chromium does not
  // start. A hard cap cannot be lifted: the message says so.
  test('under a cap on the address space, as Odoo sets it', async (t) => {
    if (process.platform !== 'linux') return t.skip('RLIMIT_AS: Linux');
    const out = join(dir, 'capped.pdf');
    let r = await run(['-q', `${base}/ok`, out], { sh: 'ulimit -S -v 2621440' });
    assert.equal(r.stderr, '');
    assert.equal(r.code, 0);
    assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-');
    r = await run(['-q', `${base}/ok`, out], { sh: 'ulimit -v 2621440' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Error: Chromium cannot start under a cap on its address space \(ulimit -v, RLIMIT_AS\) of 2560 MiB: /);
  });

  test('--debug-javascript: the console of the page and its errors, as warnings with their address and line', async () => {
    const page = file('debug-js/page.html', '<p>page</p><script>\nconsole.log("hello", 2);\nconsole.error("an error");\nmissingFunction();\n</script><script>console.group("group");</script>');
    const url = pathToFileURL(page).href;
    const out = join(dir, 'debug-js.pdf');
    const warnings = (stderr: string) => stderr.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l.startsWith('Warning: '));
    let r = await run(['--debug-javascript', page, out]);
    assert.equal(r.code, 0, r.stderr);
    // Its first argument only, and nothing for console.group, as wkhtmltopdf 0.12.6.
    assert.deepEqual(warnings(r.stderr), [`Warning: ${url}:2 hello`, `Warning: ${url}:3 an error`, `Warning: ${url}:4 ReferenceError: missingFunction is not defined`]);
    // A header page's too, as wkhtmltopdf 0.12.6 prints them: once when it
    // is measured, once for each page.
    const header = file('debug-js/header.html', '<!DOCTYPE html><p>head</p><script>console.log("from the header");</script>');
    r = await run(['--debug-javascript', '--header-html', header, page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(warnings(r.stderr).filter((w) => w.endsWith(':1 from the header')).length, 2, r.stderr);
    // Without it, under -q, or turned off after.
    for (const args of [[], ['-q', '--debug-javascript'], ['--debug-javascript', '--no-debug-javascript']]) {
      r = await run([...args, page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(warnings(r.stderr), [], args.join(' '));
    }
  });

  test('--custom-header goes to the page only, unless propagated', async () => {
    const out = join(dir, 'h.pdf');
    let r = await run(['-q', '--custom-header', 'X-Test', 'yes', `${base}/headers`, out]);
    assert.equal(r.code, 0);
    if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /X-Test=yes/);
    assert.equal(imgHeader, 'none');
    r = await run(['-q', '--custom-header', 'X-Test', 'yes', '--custom-header-propagation', `${base}/headers`, out]);
    assert.equal(r.code, 0);
    assert.equal(imgHeader, 'yes');
    // wkhtmltopdf 0.12.6 propagates with the negative option too.
    imgHeader = '';
    r = await run(['-q', '--custom-header', 'X-Test', 'yes', '--no-custom-header-propagation', `${base}/headers`, out]);
    assert.equal(r.code, 0);
    assert.equal(imgHeader, 'yes');
    // To the fonts, which the command fetches itself, of every host and
    // after a redirect, as in wkhtmltopdf.
    fontRequests.clear();
    r = await run(['-q', '--custom-header', 'X-Test', 'yes', '--custom-header-propagation', `${base}/fonts`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.fromEntries([...fontRequests].sort()), {
      '127.0.0.1/font/a.woff': 'yes, srv=1',
      '127.0.0.1/font/moved': 'yes, srv=1',
      'localhost/font/b.woff': 'yes, no cookie',
      'localhost/font/c.woff': 'yes, no cookie',
    });
  });

  test('--read-args-from-stdin: one conversion per line', async () => {
    const a = join(dir, 'ra.pdf');
    const b = join(dir, 'rb.pdf');
    // A backslash escapes the next character, as in wkhtmltopdf: Windows
    // paths are written with slashes.
    const slash = (p: string) => p.replace(/\\/g, '/');
    const r = await run(['-q', '--read-args-from-stdin'], { stdin: `${base}/ok ${slash(a)}\n${base}/ok "${slash(b)}"\n` });
    assert.equal(r.code, 0);
    assert.ok(readFileSync(a).length && readFileSync(b).length);
  });

  test('--read-args-from-stdin converts each line as it arrives', async () => {
    const a = join(dir, 'rc.pdf');
    const b = join(dir, 'rd.pdf');
    const slash = (p: string) => p.replace(/\\/g, '/');
    const [exe, argv] = command(process.env.PDFKILN_TEST_WKHTMLTOPDF, cli, ['-q', '--read-args-from-stdin']);
    const child = spawn(exe, argv, { cwd: dir, stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
    // A caller that waits for the first PDF before it writes the next line.
    child.stdin.write(`${base}/ok ${slash(a)}\n`);
    for (let i = 0; i < 300 && !existsSync(a); i++) await new Promise((ok) => setTimeout(ok, 100));
    assert.ok(existsSync(a), 'the first PDF, before the end of the input');
    child.stdin.end(`${base}/ok ${slash(b)}\n`);
    assert.equal(await exited, 0);
    assert.ok(readFileSync(b).length);
  });

  test('--cookie-jar: the cookies of one conversion for the next; a jar that cannot be written is left, as in wkhtmltopdf', async () => {
    const jar = join(dir, 'jar.txt');
    let r = await run(['-q', '--cookie-jar', jar, `${base}/set-cookie`, join(dir, 'jar1.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(jar, 'utf8'), /^secret=1;/m);
    r = await run(['-q', '--cookie-jar', jar, `${base}/show-cookie`, join(dir, 'jar2.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(shownCookie, 'secret=1');
    const out = join(dir, 'jar3.pdf');
    r = await run(['-q', '--cookie-jar', join(dir, 'no-such-folder', 'jar.txt'), `${base}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(out));
  });

  test('--cookie-jar: each request gets the cookies that match its URL, from a page opened from a file or from another site, as in wkhtmltopdf', async () => {
    // As Odoo writes it, the domain the host of the report URL; secure,
    // it goes over https only. Chromium takes neither of the last two,
    // which go back to the file all the same.
    const jar = 'ip=1; HttpOnly; domain=127.0.0.1; path=/;\nsub=1; domain=127.0.0.1; path=/seen/sub/;\n'
      + 'sec=1; secure; domain=127.0.0.1; path=/;\nlh=1; domain=localhost; path=/;\n'
      + 'nodomain=1; path=/;\nrelative=1; domain=127.0.0.1; path=relative;\n';
    const sent = {
      '127.0.0.1/seen/a.css': 'ip=1',
      '127.0.0.1/seen/sub/b.css': 'sub=1; ip=1',
      'localhost/seen/c.css': 'lh=1',
      '127.0.0.1/seen/d.svg': 'ip=1',
    };
    const out = join(dir, 'jar-sites.pdf');
    for (const [input, page] of [[file('jar-sites.html', seenPage()), {}], [`${other}/seen/page`, { 'localhost/seen/page': 'lh=1' }]] as const) {
      seenCookies.clear();
      const path = file('jar-sites.txt', jar);
      const r = await run(['-q', '--cookie-jar', path, input, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(Object.fromEntries([...seenCookies].sort()), Object.fromEntries(Object.entries({ ...sent, ...page }).sort()), input);
      assert.equal(readFileSync(path, 'utf8'), jar);
    }
    // Fonts, which the command fetches and follows itself: each hop of a
    // redirect gets the cookies of its own host, the longest path first.
    fontRequests.clear();
    const r = await run(['-q', '--cookie-jar', file('jar-fonts.txt', 'ip=1; domain=127.0.0.1; path=/;\nlh=1; domain=localhost; path=/;\n'), `${base}/fonts`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.fromEntries([...fontRequests].sort()), {
      '127.0.0.1/font/a.woff': 'no header, srv=1; ip=1',
      '127.0.0.1/font/moved': 'no header, srv=1; ip=1',
      'localhost/font/b.woff': 'no header, lh=1',
      'localhost/font/c.woff': 'no header, lh=1',
    });
  });

  test('--cookie-jar: an XMLHttpRequest with withCredentials gets the jar\'s cookies, from a page opened from a file or of another site, as in wkhtmltopdf', async () => {
    const out = join(dir, 'jar-xhr.pdf');
    for (const input of [file('jar-xhr.html', xhrPage()), `${other}/xhr-page`]) {
      xhrRequests.clear();
      const r = await run(['-q', '--cookie-jar', file('jar-xhr.txt', 'ip=1; domain=127.0.0.1; path=/;\n'), input, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(Object.fromEntries([...xhrRequests].sort()), { '/xhr/async': 'ip=1, none', '/xhr/plain': 'none, none', '/xhr/sync': 'ip=1, fr' }, input);
    }
  });

  test('--cookie: with every request of a page or a header that has no host, as in wkhtmltopdf; to its own host from a page loaded from its address', async () => {
    const out = join(dir, 'cookie-sites.pdf');
    const seen = () => Object.fromEntries([...seenCookies].sort());
    const all = { '127.0.0.1/seen/a.css': 'k=v', '127.0.0.1/seen/sub/b.css': 'k=v', 'localhost/seen/c.css': 'k=v', '127.0.0.1/seen/d.svg': 'k=v' };
    // A file, and the standard input, which goes through one.
    for (const [input, opts] of [[file('cookie-sites.html', seenPage()), {}], ['-', { stdin: seenPage() }]] as const) {
      seenCookies.clear();
      const r = await run(['-q', '--cookie', 'k', 'v', input, out], opts);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(seen(), all, input);
    }
    seenCookies.clear();
    let r = await run(['-q', '--cookie', 'k', 'v', `${other}/seen/page`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen(), { ...all, '127.0.0.1/seen/a.css': 'none', '127.0.0.1/seen/sub/b.css': 'none', '127.0.0.1/seen/d.svg': 'none', 'localhost/seen/page': 'k=v' });
    // A header given as a file, under a page of another host.
    seenCookies.clear();
    const header = file('cookie-header.html', `<link rel="stylesheet" href="${base}/seen/header.css"><p>header</p>`);
    r = await run(['-q', '--cookie', 'k', 'v', '--header-html', header, `${other}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen(), { '127.0.0.1/seen/header.css': 'k=v' });
    // Fonts, which the command fetches itself: a redirect to another host
    // leaves the cookies behind.
    fontRequests.clear();
    r = await run(['-q', '--cookie', 'k', 'v', `${base}/fonts`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.fromEntries([...fontRequests].sort()), {
      '127.0.0.1/font/a.woff': 'no header, srv=1; k=v',
      '127.0.0.1/font/moved': 'no header, srv=1; k=v',
      'localhost/font/b.woff': 'no header, no cookie',
      'localhost/font/c.woff': 'no header, no cookie',
    });
    // From a page given as a file, it follows the font to another host.
    fontRequests.clear();
    r = await run(['-q', '--cookie', 'k', 'v', file('cookie-font.html', `<style>@font-face { font-family: C; src: url(${base}/font/moved) } p { font-family: C }</style><p>c</p>`), out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.fromEntries([...fontRequests].sort()), { '127.0.0.1/font/moved': 'no header, k=v', 'localhost/font/c.woff': 'no header, k=v' });
  });

  test('--cookie-jar with --cookie: the jar keeps the servers\' cookies, not those of --cookie, which go last, as in wkhtmltopdf', async () => {
    const jar = join(dir, 'jar-and-cookie.txt');
    const out = join(dir, 'jar-and-cookie.pdf');
    rmSync(jar, { force: true });
    let r = await run(['-q', '--cookie', 'k', 'v', '--cookie-jar', jar, `${base}/set-cookie`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(jar, 'utf8'), 'secret=1; domain=127.0.0.1; path=/;\n');
    r = await run(['-q', '--cookie', 'k', 'v', '--cookie-jar', jar, `${base}/show-cookie`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(shownCookie, 'secret=1; k=v');
  });

  test('--cookie-jar with --cookie of the same name: both go, the jar\'s first, and the jar keeps its own, as in wkhtmltopdf', async () => {
    const jar = join(dir, 'jar-shadowed.txt');
    writeFileSync(jar, 'k=old; domain=127.0.0.1; path=/;\nother=1; domain=127.0.0.1; path=/;\n');
    const r = await run(['-q', '--cookie', 'k', 'new', '--cookie-jar', jar, `${base}/show-cookie`, join(dir, 'jar-shadowed.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(shownCookie, 'k=old; other=1; k=new');
    assert.equal(readFileSync(jar, 'utf8'), 'k=old; domain=127.0.0.1; path=/;\nother=1; domain=127.0.0.1; path=/;\n');
  });

  test('--custom-header goes with each hop of the page\'s redirects, as in wkhtmltopdf', async () => {
    hopHeader = '';
    const r = await run(['-q', '--custom-header', 'X-Custom', 'yes', `${base}/hop-start`, join(dir, 'hop.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(hopHeader, 'yes');
  });

  test('--cookie-jar: a secure cookie never goes over http, to localhost neither, as in wkhtmltopdf', async () => {
    const out = join(dir, 'jar-secure.pdf');
    // Alone, it leaves an empty Cookie header, where wkhtmltopdf sends none.
    for (const [jar, sent] of [['sec=1; secure; domain=127.0.0.1; path=/;\n', ''], ['sec=1; secure; domain=127.0.0.1; path=/;\nip=1; domain=127.0.0.1; path=/;\n', 'ip=1']] as const) {
      const r = await run(['-q', '--cookie-jar', file('jar-secure.txt', jar), `${base}/show-cookie`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(shownCookie, sent, jar);
    }
  });

  test('--cookie-jar: a cookie a server sets for a page opened from a file is kept, sent and written, as in wkhtmltopdf', async () => {
    const jar = join(dir, 'jar-set.txt');
    rmSync(jar, { force: true });
    seenCookies.clear();
    const r = await run(['-q', '--cookie-jar', jar, file('jar-set.html', `<p>set</p><script src="${base}/seen/set.js"></script>`), join(dir, 'jar-set.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seenCookies.get('127.0.0.1/seen/after.svg'), 'srv=1');
    assert.equal(readFileSync(jar, 'utf8'), 'srv=1; domain=127.0.0.1; path=/;\n');
  });

  test('--load-error-handling: a page that does not load aborts, is skipped or is kept', async () => {
    const bad = await new Promise<string>((ok) => {
      const s = createTcpServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => ok(`http://127.0.0.1:${port}/`));
      });
    });
    const pages = async (f: string) => (await PDFDocument.load(readFileSync(f))).getPageCount();
    const out = (m: string) => join(dir, `leh-${m}.pdf`);
    // As wkhtmltopdf 0.12.6 (Linux and Windows): the refused connection is
    // the page's error, which sets the exit code even when the page is
    // skipped or kept.
    const refused = `Error: Failed to load ${bad}, with network status code 1 and http status code 0 - Connection refused\n`;
    const last = 'Exit with code 1 due to network error: ConnectionRefusedError\n';
    let r = await run(['--log-level', 'warn', `${base}/ok`, bad, out('abort')]);
    assert.equal(r.code, 1);
    assert.ok(!existsSync(out('abort')));
    assert.equal(r.stderr, `${refused}Error: Failed loading page ${bad} (sometimes it will work just to ignore this error with --load-error-handling ignore)\n${last}`);
    r = await run(['--log-level', 'warn', '--load-error-handling', 'skip', `${base}/ok`, bad, out('skip')]);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stderr, `${refused}Warning: Failed loading page ${bad} (skipped)\n${last}`);
    assert.equal(await pages(out('skip')), 1);
    r = await run(['--log-level', 'warn', '--load-error-handling', 'ignore', `${base}/ok`, bad, out('ignore')]);
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stderr, `${refused}Warning: Failed loading page ${bad} (ignored)\n${last}`);
    assert.equal(await pages(out('ignore')), 2);
  });

  test('a header page that does not load: no PDF, as wkhtmltopdf 0.12.6; kept with --load-error-handling ignore', async () => {
    const h = await new Promise<string>((ok) => {
      const s = createTcpServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => ok(`http://127.0.0.1:${port}/h.html`));
      });
    });
    const out = join(dir, 'header-down.pdf');
    const refused = `Error: Failed to load ${h}, with network status code 1 and http status code 0 - Connection refused`;
    const last = 'Exit with code 1 due to network error: ConnectionRefusedError';
    let r = await run(['--log-level', 'warn', '--header-html', h, `${base}/ok`, out]);
    assert.equal(r.code, 1);
    assert.ok(!existsSync(out), 'no PDF');
    assert.equal(r.stderr, `${refused}\nError: Failed loading page ${h} (sometimes it will work just to ignore this error with --load-error-handling ignore)\n${last}\n`);
    // Kept: the header of each page fails too, and says so.
    r = await run(['--log-level', 'warn', '--load-error-handling', 'ignore', '--header-html', h, `${base}/ok`, out]);
    assert.equal(r.code, 1);
    assert.ok(existsSync(out), 'a PDF');
    const lines = r.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 5, r.stderr);
    assert.equal(lines[0], refused);
    assert.equal(lines[1], `Warning: Failed loading page ${h} (ignored)`);
    assert.match(lines[2]!, /^Error: Failed to load http:\/\/127\.0\.0\.1:\d+\/h\.html\?.+ - Connection refused$/);
    assert.match(lines[3]!, /^Warning: Failed loading page http:\/\/127\.0\.0\.1:\d+\/h\.html\?.+ \(ignored\)$/);
    assert.equal(lines[4], last);
  });

  test('--proxy: the pages go through it', async () => {
    const seen: string[] = [];
    const proxy = createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>proxied</p>');
    });
    await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
    try {
      // A host that resolves nowhere: only the proxy can answer for it.
      const r = await run(['-q', '--proxy', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, 'http://pdfkiln-proxied.invalid/page', join(dir, 'proxy.pdf')]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(seen.includes('http://pdfkiln-proxied.invalid/page'), JSON.stringify(seen));
    } finally {
      proxy.close();
    }
  });

  test('--user-style-sheet: a file or a data: URL', async () => {
    const pages = async (f: string) => (await PDFDocument.load(readFileSync(f))).getPageCount();
    const css = 'h1 { height: 2000px }';
    const out = join(dir, 'user-css.pdf');
    assert.equal((await run(['-q', `${base}/ok`, out])).code, 0);
    assert.equal(await pages(out), 1);
    for (const sheet of [file('user.css', css), `data:text/css;base64,${Buffer.from(css).toString('base64')}`]) {
      const r = await run(['-q', '--user-style-sheet', sheet, `${base}/ok`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(await pages(out) > 1, sheet.slice(0, 30));
    }
  });

  test('--user-style-sheet from a URL, which wkhtmltopdf ignores: loaded as the page\'s style sheets, under the same options', async () => {
    const pages = async (f: string) => (await PDFDocument.load(readFileSync(f))).getPageCount();
    const out = join(dir, 'user-css-url.pdf');
    let r = await run(['-q', '--cookie', 'k', 'v', '--custom-header', 'X-Test', 'css', '--custom-header-propagation', '--user-style-sheet', `${base}/user.css`, `${base}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(await pages(out) > 1);
    assert.equal(userCssRequest, 'k=v, css');
    // Without propagation, a custom header goes to the page only.
    r = await run(['-q', '--custom-header', 'X-Test', 'css', '--user-style-sheet', `${base}/user.css`, `${base}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(userCssRequest, 'no cookie, no header');
    // One that does not load is a style sheet in error, as the page's.
    r = await run(['--log-level', 'warn', '--user-style-sheet', `${base}/missing.css`, `${base}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, `Warning: Failed to load ${base}/missing.css (ignore)\n`);
  });

  test('--user-style-sheet ranks as a user style sheet, as in wkhtmltopdf: below the page\'s rules whatever their specificity, above them with !important; under a Content-Security-Policy too', async () => {
    // Measured on wkhtmltopdf 0.12.6: R, R, B, B, B and B on both pages,
    // which it reads without the policy.
    const sheet = file('user-rank.css', `@import url("${base}/rank/imported.css");
      .c1 { color: #0000ff } body .c2 { color: #0000ff } .c3 { color: #0000ff !important } .c4 { color: #0000ff !important }
      .c5 { color: #0000ff; display: block; height: 2000px }`);
    // Each line's colour: R for the page's, B for the user style sheet's.
    const script = `import sys, json, pymupdf
out = {}
for p in pymupdf.open(sys.argv[1]):
    for b in p.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                t = s["text"].strip()
                if t in ("C1", "C2", "C3", "C4", "C5", "C6"):
                    out[t] = "R" if s["color"] == 0xff0000 else "B" if s["color"] == 0x0000ff else hex(s["color"])
print(json.dumps(" ".join(out.get(k, "-") for k in ("C1", "C2", "C3", "C4", "C5", "C6"))))`;
    // Under the policy, its @import is not loaded: C6 stays black.
    for (const [page, colours] of [['rank', 'R R B B B B'], ['rank-csp', 'R R B B B 0x0']] as const) {
      const out = join(dir, `${page}.pdf`);
      const r = await run(['-q', '--user-style-sheet', sheet, `${base}/${page}`, out]);
      assert.equal(r.code, 0, r.stderr);
      // C5's height: the user style sheet applies.
      assert.ok((await PDFDocument.load(readFileSync(out))).getPageCount() > 1, page);
      if (hasPyMuPDF) assert.equal(JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' })), colours, page);
    }
  });

  test('--username and --password answer the server\'s HTTP authentication, for the fonts too, Basic or Digest, as in wkhtmltopdf', async () => {
    let r = await run(['-q', '--username', 'user', '--password', 'pass', `${base}/auth`, join(dir, 'auth.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    loginRequests.clear();
    r = await run(['-q', '--username', 'user', '--password', 'pass', `${base}/login/page`, join(dir, 'auth.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.fromEntries([...loginRequests].sort()), { '/login/basic.woff': 'authorized', '/login/digest.woff': 'authorized', '/login/page': 'authorized' });
  });

  test('--proxy: the fonts the command fetches go through it too, over http, in a tunnel for https, by SOCKS 5, as in wkhtmltopdf', async (t) => {
    const s = await selfSignedServer();
    if (!s) return t.skip('openssl missing');
    const port = Number(new URL(base).port);
    const tls = Number(new URL(s.url).port);
    const seen: string[] = [];
    const auth = `Basic ${Buffer.from('pu:pp').toString('base64')}`;
    let login = false;
    // An http proxy, to this file's server, and by CONNECT to the
    // self-signed one; with login, it asks for pu:pp.
    const proxy = createServer((req, res) => {
      if (login && req.headers['proxy-authorization'] !== auth) return res.writeHead(407, { 'proxy-authenticate': 'Basic realm="proxy"' }).end();
      seen.push(req.url ?? '');
      const u = new URL(req.url ?? '');
      const up = httpRequest({ host: '127.0.0.1', port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      req.pipe(up);
    });
    proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
      if (login && req.headers['proxy-authorization'] !== auth) {
        return client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\nContent-Length: 0\r\n\r\n');
      }
      seen.push(`CONNECT ${req.url}`);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tunnelTo(client, tls, head);
    });
    // A SOCKS 5 proxy, without authentication, which takes a name: the
    // self-signed server for its port, this file's for the others.
    const socks = createTcpServer((c) => {
      c.once('data', () => {
        c.write(Buffer.from([5, 0]));
        c.once('data', (d: Buffer) => {
          const name = d.subarray(5, 5 + d[4]!).toString();
          const to = d.readUInt16BE(5 + d[4]!);
          seen.push(`SOCKS ${name}:${to}`);
          c.pause();
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          tunnelTo(c, to === tls ? tls : port, Buffer.alloc(0));
        });
      });
    });
    await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
    await new Promise<void>((ok) => socks.listen(0, '127.0.0.1', ok));
    const at = (server: Server | ReturnType<typeof createTcpServer>) => (server.address() as AddressInfo).port;
    // A host that resolves nowhere: only the proxy reaches it.
    const page = `http://pdfkiln-proxied.invalid:${port}/proxied-fonts?tls=${tls}`;
    const out = join(dir, 'proxy-fonts.pdf');
    try {
      for (const [via, logged, asks] of [
        [`http://127.0.0.1:${at(proxy)}`, [`http://pdfkiln-proxied.invalid:${port}/font/p.woff`, `CONNECT pdfkiln-proxied.invalid:${tls}`], false],
        [`http://pu:pp@127.0.0.1:${at(proxy)}`, [`http://pdfkiln-proxied.invalid:${port}/font/p.woff`, `CONNECT pdfkiln-proxied.invalid:${tls}`], true],
        [`socks5://127.0.0.1:${at(socks)}`, [`SOCKS pdfkiln-proxied.invalid:${port}`, `SOCKS pdfkiln-proxied.invalid:${tls}`], false],
      ] as const) {
        seen.length = 0;
        fontRequests.clear();
        login = asks;
        const r = await run(['-q', '--proxy', via, page, out]);
        assert.equal(r.code, 0, `${via}: ${r.stderr}`);
        for (const l of logged) assert.ok(seen.includes(l), `${via}: ${l} in ${JSON.stringify(seen)}`);
        // Loopback goes around the proxy, as Chromium's requests do.
        assert.ok(!seen.some((l) => l.includes('localhost')), `${via}: ${JSON.stringify(seen)}`);
        assert.deepEqual(Object.fromEntries([...fontRequests].sort()), { 'localhost/font/l.woff': 'no header, no cookie', 'pdfkiln-proxied.invalid/font/p.woff': 'no header, no cookie' }, via);
      }
    } finally {
      proxy.close();
      socks.close();
      s.close();
    }
  });

  test('--replace fills a header variable of its own', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const out = join(dir, 'replace.pdf');
    const r = await run(['-q', '--header-center', '[who]', '--replace', 'who', 'World', `${base}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(pagesText(out)[0]!, /World/);
  });

  test("text without a family and the generic families get the fonts of wkhtmltopdf's Qt", async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    if (process.platform === 'darwin') return t.skip('Linux and Windows');
    const cases = { standard: '', serif: 'serif', sansSerif: 'sans-serif', fixed: 'monospace', cursive: 'cursive', fantasy: 'fantasy', unknown: 'NoSuchFamily' };
    const page = file('generic-families.html', Object.entries(cases).map(([k, f]) => `<p${f ? ` style="font-family: ${f}"` : ''}>${k}</p>`).join(''));
    const out = join(dir, 'generic-families.pdf');
    const r = await run(['-q', page, out]);
    assert.equal(r.code, 0, r.stderr);
    // The font of each paragraph, by its text.
    const script = 'import sys, json, pymupdf\np = pymupdf.open(sys.argv[1])[0]\nprint(json.dumps({s["text"]: s["font"] for b in p.get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"]}))';
    const fonts: Record<string, string> = JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' }));
    const got = Object.fromEntries(Object.keys(cases).map((k) => [k, fonts[k]?.replace(/^[A-Z]{6}\+/, '')]));
    if (process.platform === 'win32') {
      assert.deepEqual(got, { standard: 'TimesNewRomanPSMT', serif: 'TimesNewRomanPSMT', sansSerif: 'ArialMT', fixed: 'CourierNewPSMT', cursive: 'ComicSansMS', fantasy: 'Impact', unknown: 'TimesNewRomanPSMT' });
      return;
    }
    // Times New Roman, Arial... where fontconfig has them.
    const installed = execFileSync('fc-list', ['-f', '%{family[0]}\n', ':', 'family'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
    const qt = qtFamilies(installed, execFileSync('fc-match', ['-f', '%{family[0]}', 'Helvetica'], { encoding: 'utf8' }))!;
    const ps = (family: string) => execFileSync('fc-match', ['-f', '%{postscriptname}', family], { encoding: 'utf8' });
    assert.deepEqual(got, { standard: ps(qt.standard), serif: ps(qt.serif), sansSerif: ps(qt.sansSerif), fixed: ps(qt.fixed), cursive: ps(qt.cursive), fantasy: ps(qt.fantasy), unknown: ps(qt.standard) });
  });

  test('--grayscale: every colour in grey, a header and a JPEG image included, the text kept, as in wkhtmltopdf', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const header = file('gray/header.html', '<!DOCTYPE html><p style="color: #c00; margin: 0">HEAD</p>');
    const page = file('gray/page.html', `<!DOCTYPE html><style>.g { height: 20px; background: linear-gradient(to right, red, blue) }</style>
      <p style="color: #c00">Red text</p><div class="g"></div><p style="background: #fc0">Yellow</p>
      <img id="jpeg" width="40" height="40"><canvas id="c" width="40" height="40"></canvas>
      <script>
        const c = document.getElementById('c'), x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 40, 0);
        g.addColorStop(0, '#f00'); g.addColorStop(1, '#00f'); x.fillStyle = g; x.fillRect(0, 0, 40, 40);
        document.getElementById('jpeg').src = c.toDataURL('image/jpeg', 0.9);
      </script>`);
    // Pixels away from grey, the colour spaces and filters of the images, the text.
    const script = 'import sys, json, pymupdf\np = pymupdf.open(sys.argv[1])[0]\npix = p.get_pixmap(dpi=72)\ns, n = pix.samples, pix.n\n'
      + 'print(json.dumps({"colour": sum(1 for i in range(0, len(s), n) if max(s[i:i + 3]) - min(s[i:i + 3]) > 2), "images": [[x[5], x[8]] for x in p.get_images(full=True)], "fonts": len(p.get_fonts()), "text": p.get_text()}))';
    const look = (f: string): { colour: number; images: [string, string][]; fonts: number; text: string } => JSON.parse(execFileSync(python, ['-I', '-c', script, f], { encoding: 'utf8' }));
    const out = join(dir, 'gray.pdf');
    let r = await run(['-q', '--header-html', header, page, out]);
    assert.equal(r.code, 0, r.stderr);
    const colour = look(out);
    assert.ok(colour.colour > 0, JSON.stringify(colour));
    assert.ok(colour.images.some(([cs, f]) => f === 'DCTDecode' && cs !== 'DeviceGray'), JSON.stringify(colour.images));
    r = await run(['-q', '-g', '--header-html', header, page, out]);
    assert.equal(r.code, 0, r.stderr);
    const gray = look(out);
    assert.equal(gray.colour, 0);
    assert.ok(gray.images.length > 0 && gray.images.every(([cs]) => cs === 'DeviceGray'), JSON.stringify(gray.images));
    assert.ok(gray.fonts > 0);
    for (const s of ['Red text', 'Yellow', 'HEAD']) assert.ok(gray.text.includes(s), gray.text);
  });

  test('system-ui is a family no font has, as in wkhtmltopdf: the next of the list, else the standard family', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    // A fixed font by name, one each system has: monospace takes the
    // standard font where Courier New is missing, as on CI's Ubuntu.
    const fixed = "'Liberation Mono', 'Courier New'";
    const page = file('system-ui.html', `<!DOCTYPE html><style>.s { font: 16px system-ui, ${fixed} }</style>
      <p>standard</p><p style="font-family: system-ui">alone</p><p style="font-family: ${fixed}">fixed</p>
      <p style="font-family: system-ui, ${fixed}">list</p><p class="s">sheet</p>`);
    const out = join(dir, 'system-ui.pdf');
    const r = await run(['-q', page, out]);
    assert.equal(r.code, 0, r.stderr);
    const script = 'import sys, json, pymupdf\np = pymupdf.open(sys.argv[1])[0]\nprint(json.dumps({s["text"]: s["font"] for b in p.get_text("dict")["blocks"] for l in b.get("lines", []) for s in l["spans"]}))';
    const font: Record<string, string> = JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' }));
    assert.notEqual(font.standard, font.fixed);
    assert.deepEqual([font.alone, font.list, font.sheet], [font.standard, font.fixed, font.fixed], JSON.stringify(font));
  });

  test('each character at the advance of its font, as in wkhtmltopdf: none rounded to the pixel', async (t) => {
    if (process.platform !== 'linux') return t.skip('fontconfig: Linux');
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const page = file('advances.html', '<!DOCTYPE html><p style="font-size: 16px">The quick brown fox jumps over the lazy dog</p>');
    const out = join(dir, 'advances.pdf');
    const r = await run(['-q', page, out]);
    assert.equal(r.code, 0, r.stderr);
    // Where each character starts, in CSS px from the first: whole numbers
    // when the advances are rounded.
    const script = 'import sys, json, pymupdf\np = pymupdf.open(sys.argv[1])[0]\n'
      + 's = [s for b in p.get_text("rawdict")["blocks"] for l in b.get("lines", []) for s in l["spans"]][0]\n'
      + 'x = [c["origin"][0] for c in s["chars"]]\nprint(json.dumps([(v - x[0]) * 16 / s["size"] for v in x]))';
    const x: number[] = JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' }));
    const whole = x.filter((v) => Math.abs(v - Math.round(v)) < 0.05);
    assert.ok(x.length > 30 && whole.length < x.length / 2, JSON.stringify(x));
  });
});

describe('objects and numbering', () => {
  test('cover, pages, page-offset and footer variables', async (t) => {
    const cover = file('obj/cover.html', '<h1>Cover</h1>');
    const one = file('obj/one.html', '<title>One</title><h1>Part one</h1><div style="height:1500px"></div><p>end one</p>');
    const two = file('obj/two.html', '<title>Two</title><h1>Part two</h1>');
    const out = join(dir, 'objects.pdf');
    const r = await run(['-q', '--footer-center', '[page]/[topage] [section] [sitepage]/[sitepages]', '--page-offset', '10', 'cover', cover, one, two, out]);
    assert.equal(r.code, 0, r.stderr);
    const doc = await PDFDocument.load(readFileSync(out));
    assert.equal(doc.getPageCount(), 4);
    assert.equal(doc.getTitle(), 'One');
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const text = pagesText(out);
    assert.doesNotMatch(text[0]!, /\//, 'no footer on the cover');
    assert.match(text[1]!, /12\/14 Part one 1\/2/);
    assert.match(text[2]!, /13\/14 Part one 2\/2/);
    assert.match(text[3]!, /14\/14 Part two 1\/1/);
  });

  // Scala's spec splits --footer-font-name "Luxi Sans" in two words, "Luxi
  // and an object Sans". The quote ended the style attribute of the footer
  // text, whose number went to the top of each page.
  test('--footer-font-name with a quote: the footer at the foot of each page, as in wkhtmltopdf', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const page = file('footer-quote.html', `<title>Quote</title>${'<p>line</p>'.repeat(120)}`);
    const out = join(dir, 'footer-quote.pdf');
    const r = await run(['-q', '--footer-center', '[page]', '--footer-font-name', '"Luxi', page, out]);
    assert.equal(r.code, 0, r.stderr);
    // The numbers of each page, and whether they are in its bottom tenth.
    const script = 'import sys, json, pymupdf\nprint(json.dumps([[[w[4], w[1] > p.rect.height * 0.9] for w in p.get_text("words") if w[4].isdigit()] for p in pymupdf.open(sys.argv[1])]))';
    const pages = JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' })) as [string, boolean][][];
    assert.ok(pages.length >= 3, JSON.stringify(pages));
    assert.deepEqual(pages, pages.map((_, i) => [[String(i + 1), true]]));
  });

  test('--header-html from an http address prints, as in wkhtmltopdf', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const out = join(dir, 'web-header.pdf');
    const r = await run(['-q', '-T', '20', '--header-html', `${base}/web-header`, file('web-header/page.html', '<p>body</p>'), out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(pagesText(out)[0]!.includes('WEB HEADER'), pagesText(out)[0] ?? '');
  });

  test('--header-html receives the page parameters', async (t) => {
    const header = file('hdr/header.html', `<!doctype html><html><body><span id="o"></span><script>
      const q = new URLSearchParams(location.search);
      document.getElementById('o').textContent = 'Head ' + q.get('page') + ' of ' + q.get('topage') + ' ' + q.get('doctitle');
    </script></body></html>`);
    const page = file('hdr/page.html', `<title>Report</title>${'<p>line</p>'.repeat(120)}`);
    const out = join(dir, 'header.pdf');
    const r = await run(['-q', '--header-html', header, '--margin-top', '20', page, out]);
    assert.equal(r.code, 0, r.stderr);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const text = pagesText(out);
    assert.ok(text.length >= 2);
    text.forEach((p, i) => assert.match(p, new RegExp(`Head ${i + 1} of ${text.length} Report`)));
    // Headers load with Qt's default settings: their scripts run anyway (Frappe).
    const noJs = join(dir, 'header-nojs.pdf');
    assert.equal((await run(['-q', '--disable-javascript', '--header-html', header, '--margin-top', '20', page, noJs])).code, 0);
    assert.match(pagesText(noJs)[0]!, /Head 1 of/);
  });

  test('toc: the table of contents, its links, the outline dumped as wkhtmltopdf does', async (t) => {
    const a = file('toc/a.html', '<title>Doc A</title><h1>Intro</h1><h2>Sub</h2><div style="height:1500px"></div><h2>Later</h2>');
    const b = file('toc/b.html', '<title>Doc B</title><h1>B head</h1>');
    const out = join(dir, 'toc.pdf');
    const xml = join(dir, 'toc-outline.xml');
    const r = await run(['-q', '--page-offset', '10', '--dump-outline', xml, a, 'toc', '--toc-header-text', 'Contents', b, out]);
    assert.equal(r.code, 0, r.stderr);
    const doc = await PDFDocument.load(readFileSync(out));
    assert.equal(doc.getPageCount(), 4);
    assert.equal(readFileSync(xml, 'utf8'), `<?xml version="1.0" encoding="UTF-8"?>
<outline xmlns="http://wkhtmltopdf.org/outline">
  <item title="Doc A" page="10" link="__WKANCHOR_0" backLink="__WKANCHOR_1">
    <item title="Intro" page="11" link="__WKANCHOR_2" backLink="__WKANCHOR_3">
      <item title="Sub" page="11" link="__WKANCHOR_4" backLink="__WKANCHOR_5"/>
      <item title="Later" page="12" link="__WKANCHOR_6" backLink="__WKANCHOR_7"/>
    </item>
  </item>
  <item title="Contents" page="12" link="__WKANCHOR_c" backLink="__WKANCHOR_c">
    <item title="Contents" page="13" link="__WKANCHOR_e" backLink="__WKANCHOR_e"/>
  </item>
  <item title="Doc B" page="13" link="__WKANCHOR_8" backLink="__WKANCHOR_9">
    <item title="B head" page="14" link="__WKANCHOR_a" backLink="__WKANCHOR_b"/>
  </item>
</outline>
`);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    assert.match(pagesText(out)[2]!.replace(/\s+/g, ' '), /Contents.*Intro.*Sub.*Later.*Contents.*B head/);
    const links = JSON.parse(execFileSync(python, ['-I', '-c', 'import sys, json, pymupdf\nprint(json.dumps([l.get("page") for l in pymupdf.open(sys.argv[1])[2].get_links()]))', out], { encoding: 'utf8' }));
    assert.deepEqual(links, [0, 0, 1, 2, 3]);
  });

  test('toc: --enable-toc-back-links, from the object of the heading', async (t) => {
    const a = file('toc/back.html', '<title>Back</title><h1>First</h1><div style="height:1500px"></div><h2>Second</h2>');
    const out = join(dir, 'toc-back.pdf');
    const r = await run(['-q', '--enable-toc-back-links', 'toc', a, out]);
    assert.equal(r.code, 0, r.stderr);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    // The links of the pages after the table: each back to page 1.
    const script = 'import sys, json, pymupdf\nd = pymupdf.open(sys.argv[1])\nprint(json.dumps([[i, l.get("page")] for i, p in enumerate(d) if i for l in p.get_links()]))';
    assert.deepEqual(JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' })), [[1, 0], [2, 0]]);
  });

  test('toc: --xsl-style-sheet, and the default one dumped', async (t) => {
    const r0 = await run(['--dump-default-toc-xsl']);
    assert.equal(r0.code, 0);
    assert.match(r0.stdout.toString(), /^<\?xml version="1.0" encoding="UTF-8"\?>\n<xsl:stylesheet version="2.0"/);
    const xsl = file('toc/list.xsl', `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:o="http://wkhtmltopdf.org/outline">
  <xsl:template match="/o:outline"><html><body><p>Custom list</p><xsl:for-each select="o:item/o:item"><p>Entry <xsl:value-of select="@title"/> at <xsl:value-of select="@page"/></p></xsl:for-each></body></html></xsl:template>
</xsl:stylesheet>`);
    const page = file('toc/c.html', '<title>C</title><h1>Only heading</h1>');
    const out = join(dir, 'toc-xsl.pdf');
    const r = await run(['-q', 'toc', '--xsl-style-sheet', xsl, page, out]);
    assert.equal(r.code, 0, r.stderr);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    assert.match(pagesText(out)[0]!, /Custom list[\s\S]*Entry Only heading at 2/);
  });

  // Chromium turns XSLT off from 158: on again for --xsl-style-sheet only.
  test('toc: XSLT for --xsl-style-sheet only', async () => {
    const xsl = file('toc/plain.xsl', `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:template match="/"><html><body><p>List</p></body></html></xsl:template></xsl:stylesheet>`);
    const page = file('toc/xslt.html', '<title>X</title><h1 id="h">?</h1><script>document.getElementById("h").textContent = typeof XSLTProcessor</script>');
    const outline = join(dir, 'toc-xslt.xml');
    const headings = async (args: string[]) => {
      const r = await run(['-q', '--dump-outline', outline, ...args, page, join(dir, 'toc-xslt.pdf')]);
      assert.equal(r.code, 0, r.stderr);
      return [...readFileSync(outline, 'utf8').matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
    };
    assert.ok((await headings([])).includes('undefined'));
    assert.ok((await headings(['toc'])).includes('undefined'));
    assert.ok((await headings(['toc', '--xsl-style-sheet', xsl])).includes('function'));
  });

  // wkhtmltopdf loads its tables of contents apart from the pages, by a
  // loader that is not its main one. Scala's spec, whose table made by
  // --xsl-style-sheet never sets window.status, waited until --kiln-timeout.
  test('toc: neither --window-status nor --run-script, as in wkhtmltopdf', async (t) => {
    const page = file('toc/status.html', `<title>Status</title><h1>Status heading</h1>
      <script>addEventListener('DOMContentLoaded', () => { window.status = 'loaded'; });</script>`);
    const xsl = file('toc/status.xsl', `<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:o="http://wkhtmltopdf.org/outline">
  <xsl:template match="/o:outline"><html><body><xsl:for-each select="o:item/o:item"><p>Entry <xsl:value-of select="@title"/></p></xsl:for-each></body></html></xsl:template>
</xsl:stylesheet>`);
    const script = "document.body.insertAdjacentHTML('beforeend', '<p>RUN SCRIPT</p>')";
    for (const toc of [['toc'], ['toc', '--xsl-style-sheet', xsl]]) {
      const out = join(dir, 'toc-status.pdf');
      const r = await run(['-q', '--kiln-timeout', '20', '--window-status', 'loaded', '--javascript-delay', '1000', '--run-script', script, page, ...toc, page, out]);
      assert.equal(r.code, 0, `${toc.join(' ')}: ${r.stderr}`);
      if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
      assert.deepEqual(pagesText(out).map((p) => [p.includes('Status heading'), p.includes('RUN SCRIPT')]), [[true, true], [true, false], [true, true]], toc.join(' '));
    }
  });

  // Chromium titles a bookmark with its heading's text twice when the
  // heading, moved down by position: relative, crosses the foot of its page:
  // it is drawn on both (Scala's spec, 4 bookmarks of 358). wkhtmltopdf
  // names a bookmark after its heading's text.
  test('outline: a heading across the foot of a page, its bookmark titled once, as in wkhtmltopdf', async (t) => {
    // A4, 10 mm margins, smart shrinking: pages of 1308.7 px; the heading
    // laid out at 1267 px, drawn from 1299 to 1319.
    const page = file('outline/foot.html', `<title>Foot</title><style>body { margin: 0 } main { position: relative; top: 32px }
      h3 { margin: 0; font-size: 16px; line-height: 20px }</style><main><div style="height: 1267px"></div><h3>Default Arguments</h3><p>After</p></main>`);
    const out = join(dir, 'outline-foot.pdf');
    const xml = join(dir, 'outline-foot.xml');
    const r = await run(['-q', '--dump-outline', xml, page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...readFileSync(xml, 'utf8').matchAll(/title="([^"]*)"/g)].map((m) => m[1]), ['Foot', 'Default Arguments']);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const toc = JSON.parse(execFileSync(python, ['-I', '-c', 'import sys, json, pymupdf\nprint(json.dumps(pymupdf.open(sys.argv[1]).get_toc()))', out], { encoding: 'utf8' }));
    assert.deepEqual(toc, [[1, 'Default Arguments', 1]]);
  });

  test('links: to another object, its elements, the web; and the options that drop them', async (t) => {
    const a = file('links/a.html', `<title>A</title><p><a href="b.html">b</a></p><p><a href="b.html#sec">sec</a></p>
      <p><a href="b.html#gone">gone</a></p><p><a href="#self">self</a></p><p><a href="other.html#x">other</a></p>
      <div style="height:1200px"></div><p id="self">Self target</p>`);
    file('links/b.html', '<title>B</title><p>B top</p><div style="height:1300px"></div><h2 id="sec">B sec</h2>');
    const b = join(dir, 'links', 'b.html');
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    // Each link of the first page: its target page, the target text's
    // distance to the destination, or its URI.
    const script = `import sys, json, pymupdf
d = pymupdf.open(sys.argv[1])
out = []
for l in d[0].get_links():
    if l["kind"] in (1, 4):
        p = d[l["page"]]
        # PyMuPDF gives named destinations in PDF coordinates.
        y = l["to"].y if l["kind"] == 1 else p.rect.height - l["to"].y
        words = [w for w in p.get_text("words") if w[4] in ("Self", "sec", "top")]
        out.append([l["page"], round(min(abs(w[1] - y) for w in words))])
    else:
        out.append(l.get("uri") or l.get("file"))
print(json.dumps(out))`;
    const links = async (...opts: string[]) => {
      const out = join(dir, 'links.pdf');
      const r = await run(['-q', a, ...opts, b, out]);
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' })) as unknown[];
    };
    const all = await links();
    assert.equal(all.length, 4, JSON.stringify(all));
    const [toB, toSec, toSelf, other] = all as [[number, number], [number, number], [number, number], string];
    assert.equal(toB[0], 2);
    assert.equal(toSec[0], 3);
    assert.equal(toSelf[0], 1);
    // The destinations are where the text is (Chromium writes them unscaled).
    for (const [, gap] of [toSec, toSelf]) assert.ok(gap < 25, `destination ${gap} pt away from its target`);
    assert.match(other, /^(file:\/\/)?\/.*\/links\/other\.html/);
    assert.deepEqual(await links('--disable-internal-links'), [other]);
    assert.equal((await links('--disable-external-links')).length, 3);
    assert.match(String((await links('--keep-relative-links'))[3]), /^other\.html/);
  });

  test('--copies: collated, or page by page; links and outline on the last copy', async (t) => {
    const a = file('copies/a.html', '<title>A</title><h1>One</h1><p>Page one</p><div style="height:1500px"></div><p>Page two</p>');
    const out = join(dir, 'copies.pdf');
    for (const [opts, order] of [[[], ['one', 'two', 'one', 'two']], [['--no-collate'], ['one', 'one', 'two', 'two']]] as const) {
      const r = await run(['-q', '--copies', '2', ...opts, a, out]);
      assert.equal(r.code, 0, r.stderr);
      const doc = await PDFDocument.load(readFileSync(out));
      assert.equal(doc.getPageCount(), 4);
      if (!hasPyMuPDF) continue;
      assert.deepEqual(pagesText(out).map((p) => (/Page two/.test(p) ? 'two' : 'one')), order);
      const toc = JSON.parse(execFileSync(python, ['-I', '-c', 'import sys, json, pymupdf\nprint(json.dumps(pymupdf.open(sys.argv[1]).get_toc()))', out], { encoding: 'utf8' }));
      assert.deepEqual(toc, [[1, 'One', opts.length ? 2 : 3]]);
    }
    if (!hasPyMuPDF) t.skip('PyMuPDF missing');
  });

  test('--post and --post-file: the page is requested with the form', async (t) => {
    const out = join(dir, 'post.pdf');
    let r = await run(['-q', `${base}/post`, '--post', 'a', 'x+y z', '--post', 'b', '2', out]);
    assert.equal(r.code, 0, r.stderr);
    const sent = file('post/sent.txt', 'file content');
    if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /POST application\/x-www-form-urlencoded\s+a=x%2By\+z&b=2/);
    r = await run(['-q', `${base}/post`, '--post', 'a', '1', '--post-file', 'f', sent, out]);
    assert.equal(r.code, 0, r.stderr);
    if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /POST multipart\/form-data[\s\S]*name="f"; filename="sent.txt"\s+file content/);
    r = await run([`${base}/post`, '--post-file', 'f', join(dir, 'post', 'missing.txt'), out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unable to open file .*missing\.txt/);
    if (!hasPyMuPDF) t.skip('PyMuPDF missing');
  });

  test('--ssl-crt-path, --ssl-key-path, --ssl-key-password: the client certificate', async (t) => {
    const c = clientCerts(join(dir, 'tls'));
    if (!c) return t.skip('openssl missing');
    const tls = createHttpsServer({ key: c.key, cert: c.cert, ca: c.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      if (req.url === '/moved') return res.writeHead(302, { location: '/page' }).end();
      if (req.url === '/style.css') return res.writeHead(200, { 'content-type': 'text/css' }).end('p::after { content: " and styled" }');
      const cn = (req.socket as TLSSocket).getPeerCertificate().subject?.CN;
      res.writeHead(200, { 'content-type': 'text/html' })
        .end(`<title>T</title><link rel="stylesheet" href="/style.css"><p>${req.method} by ${cn} with ${req.headers.cookie ?? 'no cookie'}</p>`);
    });
    await new Promise<void>((ok) => tls.listen(0, '127.0.0.1', ok));
    try {
      const url = `https://localhost:${(tls.address() as AddressInfo).port}/moved`;
      const out = join(dir, 'tls.pdf');
      const r = await run(['-q', '--cookie', 'k', 'v', url, ...c.args, out]);
      assert.equal(r.code, 0, r.stderr);
      if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /GET by Kiln client with k=v and styled/);
      // Without it, the server refuses the page.
      assert.equal((await run(['-q', url, out])).code, 1);
    } finally {
      tls.close();
    }
    if (!hasPyMuPDF) t.skip('PyMuPDF missing');
  });

  test('--ssl-crt-path: the requests the command makes go through --proxy and answer --username and --password, as in wkhtmltopdf', async (t) => {
    const c = clientCerts(join(dir, 'tls-proxy'));
    if (!c) return t.skip('openssl missing');
    const seen: string[] = [];
    const login = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    // Behind a login: the page and its image, with the client's certificate.
    const tls = createHttpsServer({ key: c.key, cert: c.cert, ca: c.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      if (req.headers.authorization !== login) {
        seen.push(`${req.url} 401`);
        return res.writeHead(401, { 'www-authenticate': 'Basic realm="pdfkiln"' }).end();
      }
      seen.push(`${req.url} ${(req.socket as TLSSocket).getPeerCertificate().subject?.CN}`);
      if (req.url === '/image') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>T</title><p>page</p><img src="/image">');
    });
    // A proxy that only tunnels, to that server.
    const proxy = createServer((_req, res) => res.writeHead(502).end());
    proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
      seen.push(`CONNECT ${req.url}`);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      tunnelTo(client, (tls.address() as AddressInfo).port, head);
    });
    await new Promise<void>((ok) => tls.listen(0, '127.0.0.1', ok));
    await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
    const port = (tls.address() as AddressInfo).port;
    const out = join(dir, 'tls-proxy.pdf');
    const send = [...c.args, '--username', 'user', '--password', 'pass'];
    try {
      let r = await run(['-q', ...send, `https://localhost:${port}/page`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(seen.includes('/page Kiln client') && seen.includes('/image Kiln client'), JSON.stringify(seen));
      // A host that only the proxy reaches.
      seen.length = 0;
      r = await run(['-q', ...send, '--proxy', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, `https://pdfkiln-proxied.invalid:${port}/page`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(seen.includes(`CONNECT pdfkiln-proxied.invalid:${port}`) && seen.includes('/page Kiln client') && seen.includes('/image Kiln client'), JSON.stringify(seen));
    } finally {
      tls.close();
      proxy.close();
    }
  });

  test('the JavaScript delay waits for what is pending, not more', async (t) => {
    // A change within the delay is printed, one after it is not, as in
    // wkhtmltopdf; a quiet page is printed without waiting the whole delay.
    const page = file('delay/page.html', `<p id="a">start</p><script>
      setTimeout(() => { document.getElementById('a').textContent += ' early'; }, 150);
      setTimeout(() => { document.getElementById('a').textContent += ' late'; }, 900);
    </script>`);
    const out = join(dir, 'delay.pdf');
    assert.equal((await run(['-q', '--javascript-delay', '400', page, out])).code, 0);
    const quiet = file('delay/quiet.html', '<p>quiet</p>');
    // Against the same page without a delay: Chromium's start is in both.
    const plain = await run(['-q', '--javascript-delay', '0', quiet, join(dir, 'quiet.pdf')]);
    const r = await run(['-q', '--javascript-delay', '5000', quiet, join(dir, 'quiet.pdf')]);
    assert.equal(r.code, 0);
    assert.ok(r.ms < plain.ms + 2500, `a quiet page waited ${Math.round(r.ms - plain.ms)} ms more`);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const text = pagesText(out)[0]!;
    assert.match(text, /start early/);
    assert.doesNotMatch(text, /late/);
  });

  test('a paragraph may leave its first line alone at the bottom of a page', async (t) => {
    // No widow or orphan control unless the page asks for it, as WebKit
    // 534: A4 with 10 mm margins holds 1308 px at scale 0.8.
    const lines = Array.from({ length: 4 }, (_, i) => `L${i + 1} ${'word '.repeat(30)}`).join('<br>');
    const page = file('orphan/page.html', `<style>body{margin:0;font:16px/20px sans-serif}p{margin:0}</style><div style="height:1285px"></div><p>${lines}</p>`);
    const out = join(dir, 'orphan.pdf');
    assert.equal((await run(['-q', page, out])).code, 0);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    assert.match(pagesText(out)[0]!, /L1 word/);
  });

  test('a table row that does not fit moves to the next page, whole', async (t) => {
    // As WebKit 534: six rows of 171 px from 145 px down, past the 1122 px
    // of an A4 page without margins by 20 px; Chromium would split the last.
    const rows = Array.from({ length: 6 }, (_, i) => `<tr><td><div style="height:150px">R${i + 1}</div></td></tr>`).join('');
    const page = file('rows/page.html', `<style>body{margin:0;font:16px/20px sans-serif}table{border-collapse:collapse;width:100%}td{border:1px solid;padding:10px}</style><div style="height:115px"></div><table>${rows}</table>`);
    const out = join(dir, 'rows.pdf');
    assert.equal((await run(['-q', '--disable-smart-shrinking', '-T', '0', '-B', '0', page, out])).code, 0);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const [first, second] = pagesText(out);
    assert.doesNotMatch(first!, /R6/);
    assert.match(second!, /R6/);
  });

  test('these two breaks hold on a page whose Content-Security-Policy refuses inline styles, which wkhtmltopdf does not know', async (t) => {
    // The pages of the two tests above, served with style-src 'self': the
    // emulation's own style sheet, refused there as an element, is adopted.
    // wkhtmltopdf 0.12.6 (Windows 11): R6 on the second page, L1 on the first.
    const rows = join(dir, 'csp-rows.pdf');
    const orphan = join(dir, 'csp-orphan.pdf');
    assert.equal((await run(['-q', '--disable-smart-shrinking', '-T', '0', '-B', '0', `${base}/csp-breaks/rows`, rows])).code, 0);
    assert.equal((await run(['-q', `${base}/csp-breaks/orphan`, orphan])).code, 0);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const [first, second] = pagesText(rows);
    assert.doesNotMatch(first!, /R6/);
    assert.match(second!, /R6/);
    assert.match(pagesText(orphan)[0]!, /L1 word/);
  });

  test('a block that scrolls its overflow and does not fit moves to the next page, whole', async (t) => {
    // As WebKit 534: lines of 20 px from 1150 px down, across the first page
    // break. One that hides its overflow is split, as one taller than a page,
    // which starts where it stands.
    const page = (name: string, overflow: string, lines: number) => file(`scroll/${name}.html`, '<style>body{margin:0;font:16px/20px sans-serif}</style>'
      + `<div style="height:1150px">top</div><div style="${overflow}">${Array.from({ length: lines }, (_, i) => `L${i + 1}`).join('<br>')}</div>`);
    const pageOne = async (name: string, overflow: string, lines: number) => {
      const out = join(dir, `scroll-${name}.pdf`);
      assert.equal((await run(['-q', page(name, overflow, lines), out])).code, 0);
      return pagesText(out)[0]!;
    };
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    assert.doesNotMatch(await pageOne('auto', 'overflow: auto', 20), /L1\b/);
    assert.doesNotMatch(await pageOne('x', 'overflow-x: scroll', 20), /L1\b/);
    assert.match(await pageOne('hidden', 'overflow: hidden', 20), /L1\b/);
    assert.match(await pageOne('tall', 'overflow: auto', 80), /L1\b/);
  });

  test('breaks and named pages that came after WebKit 534 are ignored, page-break-before is kept, as in wkhtmltopdf', async () => {
    // wkhtmltopdf 0.12.6 (Windows 11): 2 pages, the last paragraph's break
    // only; Chromium would make 5.
    const page = file('breaks/page.html', '<!DOCTYPE html><style>.p{page: wide} .b{break-before: page}</style><p>one</p><p class="b">two</p>'
      + '<p class="p">three</p><p style="break-after: page">four</p><p style="page-break-before: always">five</p>');
    const out = join(dir, 'breaks.pdf');
    assert.equal((await run(['-q', page, out])).code, 0);
    assert.equal((await PDFDocument.load(readFileSync(out))).getPageCount(), 2);
  });

  test('bench switches: whole-pixel line heights, margins at the top of the page', async (t) => {
    // Off by default; PDFKILN_EMULATION turns them on for the bench.
    const page = file('whole/page.html', '<style>body{margin:0;font:12px sans-serif}p{margin:0;line-height:1.8}</style>'
      + '<div style="float:left;width:50%"><div style="margin-top:15px"><p>A1</p><p>A2</p><p>A3</p><p>A4</p><p>A5</p><p>A6</p></div></div>');
    const tops = async (env: NodeJS.ProcessEnv) => {
      const out = join(dir, 'whole.pdf');
      assert.equal((await run(['-q', '--disable-smart-shrinking', '-T', '0', '-B', '0', page, out], { env })).code, 0);
      const script = 'import sys, json, pymupdf\nw = pymupdf.open(sys.argv[1])[0].get_text("words")\nprint(json.dumps([round(x[3] / 0.75, 1) for x in sorted(w, key=lambda x: x[3])]))';
      return JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' })) as number[];
    };
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    // Over five pitches: Chromium paints each line on a whole pixel.
    const pitch = (ys: number[]) => (ys[5]! - ys[0]!) / 5;
    const a = await tops({ PDFKILN_EMULATION: '' });
    assert.ok(Math.abs(pitch(a) - 21.6) < 0.3, `pitch ${pitch(a)}`);
    const b = await tops({ PDFKILN_EMULATION: '+wholePixelLineHeights,+pageTopMargins' });
    assert.ok(Math.abs(pitch(b) - 21) < 0.3, `pitch ${pitch(b)}`);
    assert.ok(a[0]! - b[0]! > 14, `margin kept: ${a[0]} -> ${b[0]}`);
  });

  test('a frame of another origin in a page given as a file is printed where it stands, with its links, as in wkhtmltopdf', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const out = join(dir, 'frame.pdf');
    const r = await run([framePage('frames/page.html'), out]);
    assert.equal(r.code, 0, r.stderr);
    assertFramePrinted(out);
  });
});

describe('security', () => {
  test('a page given as a file: --custom-header and --post go with its own request, so nowhere, not with the request of its frame', async () => {
    frameRequests.length = 0;
    const r = await run(['--custom-header', 'X-Test', 'page-only', '--post', 'k', 'v', framePage('frames/post.html'), join(dir, 'frame-post.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(frameRequests.length > 0 && frameRequests.every((h) => h === 'GET no header, no cookie'), frameRequests.join(' | '));
  });

  test('a local page may not read its neighbours, unless allowed', async () => {
    file('local/s.css', 'p { color: red }');
    const page = file('local/page.html', '<link rel="stylesheet" href="s.css"><p>x</p>');
    let r = await run(['--log-level', 'warn', page, join(dir, 'l.pdf')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Warning: Blocked access to file .*s\.css$/m);
    assert.equal(lastLine(r.stderr), 'Exit with code 1 due to network error: ProtocolUnknownError');
    r = await run(['-q', '--enable-local-file-access', page, join(dir, 'l.pdf')]);
    assert.equal(r.code, 0);
    r = await run(['-q', '--allow', join(dir, 'local'), page, join(dir, 'l.pdf')]);
    assert.equal(r.code, 0);
  });

  // wkhtmltopdf looks for a file's canonical path among the allowed ones:
  // a missing file has none, and is refused. On Windows, Qt writes paths
  // with /.
  test('a missing file is refused, under --allow too', async () => {
    file('missing/neighbour.png', 'png');
    const page = file('missing/page.html', '<p>missing</p><img src="neighbour.png"><img src="missing.png">');
    const blocked = 'Warning: Blocked access to file \nError: Failed to load about:blank, with network status code 301 and http status code 0 - Protocol "about" is unknown\nExit with code 1 due to network error: ProtocolUnknownError\n';
    let r = await run(['--log-level', 'warn', '--allow', join(dir, 'missing'), page, join(dir, 'm.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, blocked);
    const link = join(dir, 'missing-link');
    symlinkSync(join(dir, 'missing'), link, 'junction');
    r = await run(['--log-level', 'warn', '--allow', link, join(link, 'page.html'), join(dir, 'm.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, blocked);
    r = await run(['--log-level', 'warn', '--enable-local-file-access', page, join(dir, 'm.pdf')]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, `Warning: Failed to load ${pathToFileURL(join(dir, 'missing', 'missing.png')).href} (ignore)\n`);
    const qt = (path: string) => (process.platform === 'win32' ? path.replace(/\\/g, '/') : path);
    const absent = join(dir, 'missing', 'missing.html');
    r = await run(['--log-level', 'warn', '--enable-local-file-access', file('missing/frame.html', '<iframe src="missing.html"></iframe>'), join(dir, 'm.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `Error: Failed to load ${pathToFileURL(absent).href}, with network status code 203 and http status code 0 - Error opening ${qt(absent)}: No such file or directory\nExit with code 1 due to network error: ContentNotFoundError\n`);
    r = await run(['--log-level', 'warn', file('missing/alone.html', '<img src="neighbour.png">'), join(dir, 'm.pdf')]);
    assert.equal(r.code, 1);
    const neighbour = qt(realpathSync.native(join(dir, 'missing', 'neighbour.png')));
    assert.ok(r.stderr.split('\n').includes(`Warning: Blocked access to file ${neighbour}`), r.stderr);
  });

  test('--allow cannot be left by .. or a symbolic link', async () => {
    file('secret/key.png', 'secret');
    const allowed = join(dir, 'jail');
    mkdirSync(allowed, { recursive: true });
    let linked = true;
    try {
      symlinkSync(join(dir, 'secret', 'key.png'), join(allowed, 'link.png'));
    } catch {
      // Windows without the right to create links.
      linked = false;
    }
    // Each way out on its own page: one that got through would leave its
    // page without a warning.
    for (const [name, src] of [['up', '../secret/key.png'], ['link', 'link.png'], ['root', '/etc/passwd']] as const) {
      if (name === 'link' && !linked) continue;
      const page = file(`jail/${name}.html`, `<img src="${src}">`);
      const r = await run(['--log-level', 'warn', '--allow', allowed, page, join(dir, 'j.pdf')]);
      const blocked = r.stderr.split('\n').filter((l) => l.startsWith('Warning: Blocked access to file'));
      assert.equal(blocked.length, 1, `${src}: ${r.stderr}`);
      assert.equal(r.code, 1, src);
    }
  });

  test('--kiln-block-private-network refuses loopback, by address and by name', async () => {
    for (const url of [`${base}/ok`, base.replace('127.0.0.1', 'localhost') + '/ok', base.replace('127.0.0.1', '[::ffff:127.0.0.1]') + '/ok']) {
      const r = await run(['--log-level', 'warn', '--kiln-block-private-network', url, join(dir, 'p.pdf')]);
      assert.equal(r.code, 1, url);
      // The relay's refusal is a 403, worded as wkhtmltopdf words one, with
      // the URL as Chromium writes it.
      const shown = new URL(url).href;
      assert.equal(r.stderr, `Error: Failed to load ${shown}, with network status code 202 and http status code 403 - Error downloading ${shown} - server replied: Forbidden\nExit with code 1 due to network error: ContentOperationNotPermittedError\n`);
    }
    const r = await run(['-q', `${base}/ok`, join(dir, 'p.pdf')]);
    assert.equal(r.code, 0);
  });

  test('nothing loads that wkhtmltopdf 0.12.6 never loaded: image-set(), srcset, preload links, media, SVG 2 href, srcdoc, data: frames, CSS it did not read', async () => {
    const seen: string[] = [];
    const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    const s = createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/page.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(page('page', true));
      if (req.url === '/frame.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(`<img srcset="${u}/frame-srcset.png 1x"><img src="${u}/frame-img.png">`);
      res.writeHead(200, { 'content-type': 'image/png' }).end();
    });
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const page = (p: string, frame = false) => `<style>body{background-image:image-set("${u}/${p}-image-set.png" 1x)} div{background:\\69mage-set("${u}/${p}-escaped.png" 1x)}</style>
      <p style="background-image:-webkit-image-set('${u}/${p}-attr.png' 1x)">x</p><div>escaped</div>
      <img src="${gif}" srcset="${u}/${p}-srcset.png 1x">
      <picture><source srcset="${u}/${p}-source.png"><img src="${gif}"></picture>
      <link rel="preload" as="image" imagesrcset="${u}/${p}-imagesrcset.png 1x"><link rel="prefetch" href="${u}/${p}-prefetch.html">
      <video poster="${u}/${p}-poster.png" width="10" height="10"></video>
      <svg width="10" height="10"><image href="${u}/${p}-svg2.png" width="10" height="10"/><rect width="10" height="10" fill="url(${u}/${p}-fill.svg#g)"/></svg>
      <iframe srcdoc="&lt;img src=&quot;${u}/${p}-srcdoc.png&quot;&gt;"></iframe>
      <iframe src="data:text/html,${encodeURIComponent(`<img srcset="${u}/${p}-data-frame.png 1x">`)}"></iframe>
      <style>@supports (display:block){.s{background:url(${u}/${p}-supports.png)}} :is(.i){background:url(${u}/${p}-is.png)}
        .g{background-image:linear-gradient(red,blue),url(${u}/${p}-gradient.png)} @media (min-width: 500px){.m{background:url(${u}/${p}-media.png)}}
        @font-face{font-family:k;src:url(${u}/${p}-font.woff2) format("woff2"),url(${u}/${p}-font.woff) format("woff")} .f{font-family:k}</style>
      <div class="s">s</div><div class="i">i</div><div class="g">g</div><div class="m">m</div><div class="f">f</div>
      ${frame ? `<iframe src="${u}/frame.html"></iframe>` : ''}<img src="${u}/${p}-img.png">`;
    try {
      // On the standard input, as libraries give it, without and with
      // JavaScript. Of the fonts, the woff one, as WebKit 534 passed over
      // woff2.
      for (const js of [['--disable-javascript'], []]) {
        seen.length = 0;
        const r = await run(['-q', ...js, '-', join(dir, 'loads.pdf')], { stdin: page('stdin') });
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(seen.sort(), ['/stdin-font.woff', '/stdin-img.png'], js.join(' '));
      }
      // From the network, with a frame from there too.
      seen.length = 0;
      const r = await run(['-q', '--disable-javascript', `${u}/page.html`, join(dir, 'loads.pdf')]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(seen.sort(), ['/frame-img.png', '/frame.html', '/page-font.woff', '/page-img.png', '/page.html']);
    } finally {
      s.close();
    }
  });

  test('a page given as a file is read in the charset it declares or --encoding gives, else as UTF-8 when it is, else as windows-1252, as wkhtmltopdf', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    // αβ in Shift_JIS: Greek, which the fonts of every system draw.
    const greek = Buffer.from([0x83, 0xbf, 0x83, 0xc0]);
    const cases: [string, Buffer, string[], RegExp][] = [
      ['utf8.html', Buffer.from('<p>café crème</p>', 'utf8'), [], /café crème/],
      ['cp1252.html', Buffer.from('<p>café </p>', 'latin1'), [], /café €/],
      ['meta-sjis.html', Buffer.concat([Buffer.from('<meta charset="shift_jis"><p>'), greek, Buffer.from('</p>')]), [], /αβ/],
      ['option-sjis.html', Buffer.concat([Buffer.from('<p>'), greek, Buffer.from('</p>')]), ['--encoding', 'shift_jis'], /αβ/],
      // Where Chromium would guess Shift_JIS.
      ['undeclared-sjis.html', Buffer.concat([Buffer.from('<p>'), greek, Buffer.from('</p>')]), [], /ƒ¿ƒÀ/],
    ];
    for (const [name, bytes, args, text] of cases) {
      const page = join(dir, 'charsets', name);
      mkdirSync(dirname(page), { recursive: true });
      writeFileSync(page, bytes);
      const out = join(dir, 'charsets', `${name}.pdf`);
      const r = await run(['-q', ...args, page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(pagesText(out)[0]!, text, name);
    }
  });

  test('a certificate that does not verify is ignored, with a warning per connection, as wkhtmltopdf 0.12.6; --kiln-block-invalid-certificates refuses it', async (t) => {
    const s = await selfSignedServer();
    if (!s) return t.skip('openssl missing');
    try {
      const out = join(dir, 'self-signed.pdf');
      // The page, its image, and its font, fetched by the command.
      let r = await run(['--log-level', 'warn', s.url, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, 'Warning: SSL error ignored\n'.repeat(3));
      if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /self-signed/);
      r = await run(['--log-level', 'warn', '--kiln-block-invalid-certificates', s.url, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `Error: Failed to load ${s.url}, with network status code 6 and http status code 0 - SSL handshake failed\n`
        + `Error: Failed loading page ${s.url} (sometimes it will work just to ignore this error with --load-error-handling ignore)\n`
        + 'Exit with code 1 due to network error: SslHandshakeFailedError\n');
      // The font of a local page, refused by the command as Chromium refuses
      // the page.
      const page = file('self-signed/font.html', `<style>@font-face { font-family: F; src: url(${s.url}font) } p { font-family: F }</style><p>font</p>`);
      r = await run(['--log-level', 'warn', '--kiln-block-invalid-certificates', page, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `Error: Failed to load ${s.url}font, with network status code 6 and http status code 0 - SSL handshake failed\n`
        + 'Exit with code 1 due to network error: SslHandshakeFailedError\n');
    } finally {
      s.close();
    }
    if (!hasPyMuPDF) t.skip('PyMuPDF missing');
  });

  test('--kiln-timeout stops the conversion and Chromium', async () => {
    // A temporary folder of its own: the Chromium looked for is this
    // conversion's, whatever else runs on the machine.
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    const r = await run(['-q', '--kiln-timeout', '2', `${base}/hang`, join(dir, 't.pdf')], { env: { TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    for (const h of hangs) h();
    hangs = [];
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--kiln-timeout/);
    assert.ok(r.ms < 15000, `${r.ms} ms`);
    if (process.platform !== 'win32') {
      // Killed processes take a moment to disappear from ps.
      const left = () => execFileSync('ps', ['-eo', 'stat,args'], { encoding: 'utf8' }).split('\n')
        .some((l) => !l.startsWith('Z') && l.includes('chrome-headless-shell') && l.includes(tmp));
      for (let i = 0; i < 20 && left(); i++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(!left(), 'no Chromium left');
    }
  });

  // On Windows, Chromium's profile stays locked until it is gone, which
  // can be seconds after taskkill returns for a page stuck in a script.
  test('--kiln-timeout leaves no temporary folder, a page stuck in a script', async () => {
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    for (let i = 0; i < 3; i++) {
      const r = await run(['-q', '--kiln-timeout', '2', '-', join(dir, 'loop.pdf')], {
        stdin: '<script>while (true) {}</script>',
        env: { TEMP: tmp, TMP: tmp, TMPDIR: tmp },
      });
      assert.equal(r.code, 1);
      assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith('pdfkiln-')), []);
    }
  });

  // Chromium is gone and its folder removed by the time the command returns.
  test('a conversion leaves nothing behind: its folder goes, the caller\'s folder is free at once', async () => {
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    for (let i = 0; i < 3; i++) {
      const cwd = mkdtempSync(join(dir, 'cwd-'));
      const r = await run(['-q', `${base}/ok`, join(dir, 'leave.pdf')], { cwd, env: { TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
      assert.equal(r.code, 0, r.stderr);
      // A caller that removes the folder it ran the command in.
      rmSync(cwd, { recursive: true });
      assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith('pdfkiln-')), [], 'gone when the command returns');
    }
  });

  // The header's measure, started with the page, outlives it: Chromium
  // closes under it.
  test('a header measured while the page fails to load: wkhtmltopdf\'s last line, no folder left', async () => {
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    const header = file('measured-header.html', '<p>Header</p>');
    const r = await run(['-q', '--header-html', header, '-T', '20mm', 'http://pdfkiln-nonexistent.invalid/', join(dir, 'measured.pdf')], { env: { TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Exit with code 1 due to network error: HostNotFoundError\n$/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    for (let i = 0; i < 50 && readdirSync(tmp).some((f) => f.startsWith('pdfkiln-')); i++) await new Promise((ok) => setTimeout(ok, 100));
    assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith('pdfkiln-')), []);
  });

  test('a failure of PDFKiln\'s own ends on wkhtmltopdf\'s last line, not on a stack trace', async () => {
    // Kept by --load-error-handling ignore, the header that does not load
    // goes on to a URL that cannot be made.
    const r = await run(['-q', '--load-error-handling', 'ignore', '--header-html', 'no such header.html', `${base}/ok`, join(dir, 'own.pdf')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^Error: .+\n(.+\n)*Exit with code 1, due to unknown error\.\n$/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });

  // Puppeteer's browser.close() runs taskkill, its error let through to
  // stderr, when Chromium's answer to Browser.close is lost: seen in CI
  // (18/11/2026) as "ERROR: The process ... not found." after a PDF.
  // Disconnected first, the answer is lost every time. The engine from the
  // sources, with their Chromium: not run against a package.
  test('closing Chromium never runs Puppeteer\'s taskkill, even without its answer', { skip: Boolean(process.env.PDFKILN_TEST_WKHTMLTOPDF) && 'the engine, tested from the sources' }, async () => {
    const execSync = childProcess.execSync;
    const commands: string[] = [];
    childProcess.execSync = ((command: string, ...rest: unknown[]) => {
      commands.push(String(command));
      return (execSync as (...a: unknown[]) => unknown)(command, ...rest);
    }) as typeof childProcess.execSync;
    try {
      for (const answered of [true, false]) {
        const work = mkdtempSync(join(dir, 'close-'));
        const session = await launch({ dir: work });
        // An answer first: Puppeteer has nothing left to write.
        await session.browser.version();
        if (!answered) await session.browser.disconnect();
        await session.close();
        rmSync(work, { recursive: true, force: true });
      }
    } finally {
      childProcess.execSync = execSync;
    }
    assert.deepEqual(commands.filter((c) => /taskkill/i.test(c)), []);
  });

  test('Ctrl+C or SIGTERM: Chromium and the temporary folder go too', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
    const tmp = mkdtempSync(join(dir, 'tmp-'));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const [exe, argv] = command(process.env.PDFKILN_TEST_WKHTMLTOPDF, cli, ['-q', `${base}/hang`, join(dir, 'signal.pdf')]);
      const child = spawn(exe, argv, { cwd: dir, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp }, stdio: 'ignore' });
      const exited = new Promise<{ code: number | null; s: NodeJS.Signals | null }>((ok) => child.on('exit', (code, s) => ok({ code, s })));
      // Once Chromium runs: its profile is in the conversion's folder.
      const running = () => readdirSync(tmp).some((f) => f.startsWith('pdfkiln-') && existsSync(join(tmp, f, 'chromium')));
      for (let i = 0; i < 150 && !running(); i++) await new Promise((ok) => setTimeout(ok, 100));
      assert.ok(running(), 'Chromium started');
      child.kill(signal);
      // Ended by the signal, once its folder is removed; or by the
      // conversion's own failure, should Chromium's end reach it first.
      const end = await exited;
      assert.ok(end.s === signal || (end.code ?? 0) > 0, JSON.stringify(end));
      for (const h of hangs) h();
      hangs = [];
      assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith('pdfkiln-')), [], signal);
    }
  });
});

describe('native interface', () => {
  const pdfkiln = bundled ? join(root, 'dist', 'bundle', 'pdfkiln.cjs') : join(root, 'dist', 'src', 'bin', 'pdfkiln.js');
  const native = (args: string[], stdin: string | Buffer = '', env?: NodeJS.ProcessEnv): Promise<Run> => new Promise((ok) => {
    const t0 = performance.now();
    const child = spawn(...command(process.env.PDFKILN_TEST_PDFKILN, pdfkiln, args), { cwd: dir, env: env && { ...process.env, ...env } });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => ok({ code, stdout: Buffer.concat(out), stderr: err, ms: performance.now() - t0 }));
    child.stdin.end(stdin);
  });
  // The first page's paper: A4 (Chromium's default comes out at 595.9 pt
  // wide), A5 landscape, or its size in points.
  const paper = async (f: string) => {
    const { width, height } = (await PDFDocument.load(readFileSync(f), { updateMetadata: false })).getPage(0).getSize();
    const near = (w: number, h: number) => Math.abs(width - w) < 1.5 && Math.abs(height - h) < 1.5;
    return near(595.3, 841.9) ? 'A4' : near(595.3, 419.5) ? 'A5 landscape' : `${width} x ${height}`;
  };

  test('@page gives the size; print media', async () => {
    const page = file('native/a5.html', '<style>@page { size: A5 landscape; margin: 0 } @media screen { p { display: none } }</style><p>printed</p>');
    const out = join(dir, 'a5.pdf');
    const r = await native([page, out]);
    assert.equal(r.code, 0, r.stderr);
    const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
    const { width, height } = doc.getPage(0).getSize();
    assert.ok(Math.abs(width - 595.3) < 1 && Math.abs(height - 419.5) < 1, `${width} x ${height}`);
    assert.deepEqual([doc.getCreator(), doc.getProducer()], [`PDFKiln ${version}`, 'pdfkiln.org']);
  });

  test('standard input and output, several inputs merged', async () => {
    const one = file('native/one.html', '<h1>One</h1>');
    const r = await native(['-', one, '-'], '<h1>Zero</h1>');
    assert.equal(r.code, 0, r.stderr);
    assert.equal((await PDFDocument.load(r.stdout)).getPageCount(), 2);
  });

  test('--tagged keeps the structure, --outline adds bookmarks', async () => {
    const page = file('native/t.html', '<h1>Title</h1><h2>Sub</h2><p>text</p>');
    const out = join(dir, 't.pdf');
    let r = await native(['--tagged', '--outline', page, out]);
    assert.equal(r.code, 0, r.stderr);
    let doc = await PDFDocument.load(readFileSync(out));
    assert.ok(doc.catalog.get(PDFName.of('StructTreeRoot')));
    assert.ok(doc.catalog.get(PDFName.of('Outlines')));
    r = await native([page, out]);
    doc = await PDFDocument.load(readFileSync(out));
    assert.equal(doc.catalog.get(PDFName.of('StructTreeRoot')), undefined);
    assert.equal(doc.catalog.get(PDFName.of('Outlines')), undefined);
  });

  test('--pdfa and --factur-x: PDF/A, the invoice attached; a mistake refused before the render', async () => {
    const page = file('native/invoice.html', '<h1>Facture 2026/11/000042</h1><p>Total : 1 728,00 €</p>');
    const out = join(dir, 'invoice.pdf');
    let r = await native(['--factur-x', invoiceXml, page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await archived(out), { part: '3', conformance: 'B', files: ['factur-x.xml /Data'] });
    // A bare --pdfa takes the default level, not the input after it.
    r = await native(['--pdfa', page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await archived(out), { part: '3', conformance: 'B', files: [] });
    r = await native(['--pdfa=2u', '--tagged', page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await archived(out), { part: '2', conformance: 'U', files: [] });
    // Refused before Chromium starts: the reason, and no PDF.
    rmSync(out);
    r = await native(['--pdfa=1b', page, out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^pdfkiln: --pdfa: PDF\/A-1 forbids transparency/);
    r = await native(['--pdfa=2b', '--factur-x', invoiceXml, page, out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^pdfkiln: --factur-x: an invoice travels in PDF\/A-3/);
    r = await native(['--factur-x', join(dir, 'none.xml'), page, out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^pdfkiln: --factur-x: cannot read .*none\.xml: no such file/);
    assert.equal(existsSync(out), false);
  });

  test('the JavaScript delay waits for what is pending, 1000 ms at most', async (t) => {
    // A change after loading is printed; one after the bound is not, though
    // its timer keeps the page busy; a quiet page does not wait the delay.
    const page = file('native/delay.html', `<p id="a">start</p><script>
      setTimeout(() => { document.getElementById('a').textContent += ' early'; }, 300);
      setTimeout(() => { document.getElementById('a').textContent += ' late'; }, 3000);
    </script>`);
    const out = join(dir, 'native-delay.pdf');
    assert.equal((await native([page, out])).code, 0);
    const quiet = file('native/quiet.html', '<p>quiet</p>');
    // Against the same page without a delay: Chromium's start is in both.
    const plain = await native(['--javascript-delay', '0', quiet, join(dir, 'native-quiet.pdf')]);
    const r = await native(['--javascript-delay', '5000', quiet, join(dir, 'native-quiet.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < plain.ms + 2500, `a quiet page waited ${Math.round(r.ms - plain.ms)} ms more`);
    assert.equal((await native(['--javascript-delay', 'soon', quiet, join(dir, 'native-quiet.pdf')])).code, 1);
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const text = pagesText(out)[0]!;
    assert.match(text, /start early/);
    assert.doesNotMatch(text, /late/);
  });

  test('beacons, CSP reports and responses Chromium keeps from the page are not errors', async () => {
    const r = await native(['--allow-private-network', `${base}/extras`, join(dir, 'native-extras.pdf')]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  test('private addresses are refused by default: such an input fails, without PDF', async () => {
    const out = join(dir, 'native-private.pdf');
    // An address is private, a name resolves to one; so is an IPv4
    // address in IPv6 form, which the URL writes in hexadecimal.
    const mapped = base.replace('127.0.0.1', '[::ffff:127.0.0.1]');
    for (const [url, host] of [[`${base}/ok`, '127.0.0.1 is'], [`${other}/ok`, 'localhost resolves to'], [`${mapped}/ok`, '[::ffff:7f00:1] is']] as const) {
      const r = await native([url, out]);
      assert.equal(r.code, 1, r.stderr);
      assert.ok(!existsSync(out), 'no PDF');
      assert.equal(r.stderr, `pdfkiln: error: could not load ${url}: ${host} a private address (--allow-private-network to reach it)\n`);
    }
    const r = await native(['--allow-private-network', `${base}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(out));
  });

  test('an input in HTTP error fails, without PDF', async () => {
    const out = join(dir, 'native-404.pdf');
    const r = await native(['--allow-private-network', `${base}/404`, out]);
    assert.equal(r.code, 1);
    assert.ok(!existsSync(out), 'no PDF');
    assert.equal(r.stderr, `pdfkiln: error: could not load ${base}/404: HTTP 404\n`);
  });

  test('an input that does not load: one error, that says why', async () => {
    const out = join(dir, 'native-unreachable.pdf');
    // A port nothing listens on, and a server that closes the connection
    // without an answer.
    const closed = await new Promise<number>((ok) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        s.close(() => ok(port));
      });
    });
    const closing = createTcpServer((socket) => socket.once('data', () => socket.end()));
    await new Promise<void>((ok) => closing.listen(0, '127.0.0.1', ok));
    try {
      for (const [args, why] of [
        // The relay's 502 and closed tunnels, named.
        [['http://pdfkiln-nonexistent.invalid/'], 'host not found'],
        [['https://pdfkiln-nonexistent.invalid/'], 'host not found'],
        [[`https://127.0.0.1:${closed}/`], '127.0.0.1 is a private address (--allow-private-network to reach it)'],
        // Chromium's own errors, without the relay; a refused connection on
        // the page itself too.
        [['--allow-private-network', 'http://pdfkiln-nonexistent.invalid/'], 'host not found'],
        [['--allow-private-network', `http://127.0.0.1:${closed}/`], 'connection refused'],
        [['--allow-private-network', `http://127.0.0.1:${(closing.address() as AddressInfo).port}/`], 'connection closed'],
        // No "Authentication Required": the status says it.
        [['--allow-private-network', `${base}/auth`], 'HTTP 401'],
      ] as const) {
        const r = await native([...args, out]);
        assert.equal(r.code, 1, r.stderr);
        assert.equal(r.stderr, `pdfkiln: error: could not load ${args.at(-1)}: ${why}\n`);
        assert.ok(!existsSync(out), 'no PDF');
      }
    } finally {
      closing.close();
    }
  });

  test('a certificate that does not verify is refused and named, fonts included, unless --allow-invalid-certificates', async (t) => {
    const s = await selfSignedServer();
    if (!s) return t.skip('openssl missing');
    try {
      const out = join(dir, 'native-tls.pdf');
      let r = await native(['--allow-private-network', s.url, out]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`^pdfkiln: error: could not load ${s.url}: invalid certificate \\(net::ERR_CERT_[A-Z_]+\\)\\n$`));
      // The page, its image and its font, without a word.
      r = await native(['--allow-private-network', '--allow-invalid-certificates', s.url, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
      // A font, which the command fetches itself.
      const page = file('native-tls/font.html', `<style>@font-face { font-family: F; src: url(${s.url}font) } p { font-family: F }</style><p>font</p>`);
      r = await native(['--allow-private-network', page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, new RegExp(`^pdfkiln: warning: could not load ${s.url}font: invalid certificate \\([A-Z_]+\\)\\n$`));
      r = await native(['--allow-private-network', '--allow-invalid-certificates', page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
    } finally {
      s.close();
    }
  });

  test('a resource that does not load is a warning, which says why; -q hides it', async () => {
    const out = join(dir, 'native-resources.pdf');
    let r = await native(['--allow-private-network', `${base}/resources`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(out));
    // Media for wkhtmltopdf or not: a font, images with and without an
    // extension, a style sheet, a frame, a request of a script.
    assert.deepEqual(r.stderr.trim().split(/\r?\n/).sort(),
      ['data', 'font', 'frame', 'image', 'image.png', 'style.css'].map((p) => `pdfkiln: warning: could not load ${base}/${p}: HTTP 404`).sort());
    r = await native(['-q', '--allow-private-network', `${base}/resources`, out]);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  test('local files: one not allowed, one missing, a warning each', async () => {
    file('native/files/neighbour.png', 'png');
    const page = file('native/files/page.html', '<p>files</p><img src="neighbour.png"><img src="missing.png">');
    const out = join(dir, 'native-files.pdf');
    const url = (name: string) => pathToFileURL(join(dir, 'native', 'files', name)).href;
    const refused = 'not an allowed file (--allow <path> or --enable-local-file-access to read it)';
    let r = await native([page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stderr.trim().split(/\r?\n/).sort(), [`pdfkiln: warning: could not load ${url('missing.png')}: ${refused}`, `pdfkiln: warning: could not load ${url('neighbour.png')}: ${refused}`]);
    r = await native(['--allow', join(dir, 'native', 'files'), page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, `pdfkiln: warning: could not load ${url('missing.png')}: no such file\n`);
    // Through a link to the folder, as macOS's /var or a Windows short
    // name: the same.
    const link = join(dir, 'native', 'files-link');
    symlinkSync(join(dir, 'native', 'files'), link, 'junction');
    r = await native(['--allow', link, join(link, 'page.html'), out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, `pdfkiln: warning: could not load ${pathToFileURL(join(link, 'missing.png')).href}: no such file\n`);
  });

  test('--fail-on-resource-error: no PDF, an error for each resource that does not load, -q or not', async () => {
    const out = join(dir, 'native-strict.pdf');
    rmSync(out, { force: true });
    const errors = ['data', 'font', 'frame', 'image', 'image.png', 'style.css'].map((p) => `pdfkiln: error: could not load ${base}/${p}: HTTP 404`).sort();
    for (const quiet of [[], ['-q']]) {
      const r = await native([...quiet, '--fail-on-resource-error', '--allow-private-network', `${base}/resources`, out]);
      assert.equal(r.code, 1);
      assert.deepEqual(r.stderr.trim().split(/\r?\n/).sort(), errors);
      assert.ok(!existsSync(out), 'no PDF');
    }
    // Every one, those printing asks for included: an image added after
    // the load, a lazy one far below, which only printing loads; the reasons
    // of the warnings.
    const page = file('native/strict/page.html', `<p>strict</p><img src="refused.png"><div style="height: 6000px"></div><img loading="lazy" src="lazy.png">
      <script>setTimeout(() => document.body.append(Object.assign(new Image(), { src: 'late.png' })), 300);</script>`);
    const url = (name: string) => pathToFileURL(join(dir, 'native', 'strict', name)).href;
    let r = await native(['--fail-on-resource-error', page, out]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.stderr.trim().split(/\r?\n/).sort(), ['late.png', 'lazy.png', 'refused.png']
      .map((n) => `pdfkiln: error: could not load ${url(n)}: not an allowed file (--allow <path> or --enable-local-file-access to read it)`));
    r = await native(['--fail-on-resource-error', '--allow', join(dir, 'native', 'strict'), page, out]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.stderr.trim().split(/\r?\n/).sort(), ['late.png', 'lazy.png', 'refused.png'].map((n) => `pdfkiln: error: could not load ${url(n)}: no such file`));
    assert.ok(!existsSync(out), 'no PDF');
    // Everything loaded: the PDF, as without it.
    r = await native(['--fail-on-resource-error', '--allow-private-network', `${base}/ok`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.ok(existsSync(out));
  });

  test('--title, --author, --subject and --keywords: the PDF\'s properties, the page\'s title otherwise', async () => {
    const page = file('native/properties.html', '<title>The page</title><p>properties</p>');
    const out = join(dir, 'native-properties.pdf');
    const properties = async () => {
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      return [doc.getTitle(), doc.getAuthor(), doc.getSubject(), doc.getKeywords(), doc.getCreator(), doc.getProducer()];
    };
    let r = await native([page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await properties(), ['The page', undefined, undefined, undefined, `PDFKiln ${version}`, 'pdfkiln.org']);
    r = await native(['--title', 'Facture n° 42 — été', '--author', 'ACME SARL', '--subject', 'Invoice', '--keywords', 'invoice, 2026', page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(await properties(), ['Facture n° 42 — été', 'ACME SARL', 'Invoice', 'invoice, 2026', `PDFKiln ${version}`, 'pdfkiln.org']);
  });

  test('--header and --cookie go with the requests to the input\'s host, and no other', async () => {
    const out = join(dir, 'native-site.pdf');
    const send = ['--allow-private-network', '--header', 'X-Test: yes', '--cookie', 'session=abc'];
    let r = await native([...send, `${base}/headers`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([imgHeader, imgCookie], ['yes', 'session=abc']);
    // An image of another host.
    r = await native([...send, `${base}/third-party`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([imgHeader, imgCookie], ['none', 'none']);
    // Fonts, which the command fetches itself, with the cookie the page's
    // server set too, the longest path first: a redirect to another host
    // leaves them behind.
    fontRequests.clear();
    r = await native([...send, `${base}/fonts`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.fromEntries([...fontRequests].sort()), {
      '127.0.0.1/font/a.woff': 'yes, srv=1; session=abc',
      '127.0.0.1/font/moved': 'yes, srv=1; session=abc',
      'localhost/font/b.woff': 'no header, no cookie',
      'localhost/font/c.woff': 'no header, no cookie',
    });
    // Secure by default: a font or an image that another host moves to the
    // input's takes neither there, that request being chosen by another
    // site; the image gets an empty Cookie header, so that Chromium adds
    // none. The input keeps both through its own redirects.
    fontRequests.clear();
    r = await native([...send, `${base}/fonts-back`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(Object.fromEntries([...fontRequests].sort()), { '127.0.0.1/font/home.woff': 'no header, no cookie', 'localhost/font/back': 'no header, no cookie' });
    r = await native([...send, `${base}/headers-back`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([imgHeader, imgCookie], ['none', '']);
    r = await native([...send, `${base}/page-out`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([pageRequest, imgHeader, imgCookie], ['yes, session=abc', 'yes', 'session=abc']);
    for (const [flag, value, message] of [['--header', 'no colon', '"name: value"'], ['--cookie', 'nameonly', 'name=value']]) {
      r = await native([flag!, value!, `${base}/ok`, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: ${flag} takes ${message}, not ${value}\n`);
    }
  });

  test('--wait-for waits for an element, whatever the delay', async () => {
    // The element comes with a rule that turns the page to A5 landscape.
    const page = file('native/late.html', `<p>start</p><script>
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p id="ready">ready</p><style>@page { size: A5 landscape }</style>'), 1500);
    </script>`);
    const out = join(dir, 'native-late.pdf');
    let r = await native(['--javascript-delay', '200', page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await paper(out), 'A4');
    r = await native(['--javascript-delay', '200', '--wait-for', '#ready', page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await paper(out), 'A5 landscape');
    r = await native(['--wait-for', '###', page, out]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'pdfkiln: error: --wait-for takes a CSS selector, not ###\n');
  });

  test('--css comes after the page\'s own rules; --media screen leaves its print rules out', async () => {
    const out = join(dir, 'native-css.pdf');
    const css = file('native/a5.css', '@page { size: A5 landscape }');
    let r = await native(['--css', css, file('native/a4.html', '<style>@page { size: A4 }</style><p>A4 by the page</p>'), out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await paper(out), 'A5 landscape');
    const printOnly = file('native/print-a5.html', '<style>@media print { @page { size: A5 landscape } }</style><p>A5 in print</p>');
    r = await native([printOnly, out]);
    assert.equal(await paper(out), 'A5 landscape');
    r = await native(['--media', 'screen', printOnly, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await paper(out), 'A4');
    r = await native(['--media', 'tv', printOnly, out]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'pdfkiln: --media takes print or screen\n');
    const missing = join(dir, 'missing.css');
    r = await native(['--css', missing, printOnly, out]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `pdfkiln: --css: cannot read ${missing}\n`);
  });

  test('--css applies under a Content-Security-Policy that refuses inline styles, which stays in force for the page', async () => {
    const out = join(dir, 'native-css-csp.pdf');
    const r = await native(['--allow-private-network', '--css', file('native/csp-a5.css', '@page { size: A5 landscape }'), `${base}/csp`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(await paper(out), 'A5 landscape');
    // The page's own inline style, refused by its policy, still is.
    if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /shown: the page's inline style is refused/);
  });

  test('the page\'s media queries and its window see the paper it sets for all its pages; a document whose pages differ keeps A4 for them', async () => {
    // Narrow or wide, as the media queries see the page; the window, once
    // resized, for title. A4 with its 1 cm margins holds 718 px, 1047 in
    // landscape.
    const rules = '.w::after { content: "narrow" } @media (min-width: 1000px) { .w::after { content: "wide" } }';
    const resized = '<script>addEventListener("resize", () => { document.title = `${innerWidth} x ${innerHeight}` })</script>';
    const out = join(dir, 'native-paper.pdf');
    // The paper of each page, its text, and whether the page was printed
    // again on its paper (PDFKILN_TIMINGS: the "paper" step).
    const made = async (name: string, css: string, ...args: string[]) => {
      const r = await native([...args, file(`native/paper/${name}.html`, `<title>T</title><style>${css} ${rules}</style><p class="w"></p>${resized}`), out], '', { PDFKILN_TIMINGS: '1' });
      assert.equal(r.code, 0, r.stderr);
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      const near = (a: number, b: number) => Math.abs(a - b) < 1.5;
      const sizes = doc.getPages().map((p) => p.getSize()).map(({ width, height }) => (near(width, 595.3) && near(height, 841.9) ? 'A4' : near(width, 841.9) && near(height, 595.3) ? 'A4 landscape' : `${width} x ${height}`));
      return { sizes, title: doc.getTitle(), again: 'paper' in JSON.parse(lastLine(r.stderr)!), text: hasPyMuPDF ? pagesText(out)[0]!.trim() : undefined };
    };
    // Chromium's A4 landscape: 841.92 x 594.96 pt.
    let m = await made('landscape', '@page { size: A4 landscape }');
    assert.deepEqual([m.sizes, m.title, m.again], [['A4 landscape'], '1123 x 793', true]);
    if (hasPyMuPDF) assert.equal(m.text, 'wide');
    // Smaller, the page holds a window as much wider.
    m = await made('landscape-scale', '@page { size: A4 landscape }', '--scale', '0.5');
    assert.deepEqual([m.sizes, m.title, m.again], [['A4 landscape'], '2245 x 1587', true]);
    // A4 portrait, set by the page or not: printed once, as before.
    for (const css of ['@page { size: A4 }', '@page { margin: 0 }', '']) {
      m = await made('a4', css);
      assert.deepEqual([m.sizes, m.title, m.again], [['A4'], 'T', false], css);
      if (hasPyMuPDF) assert.equal(m.text, 'narrow');
    }
    // The first page in landscape, the next in A4: as before.
    m = await made('first', '@page :first { size: A4 landscape } body::after { content: ""; display: block; height: 3000px }');
    assert.deepEqual([m.sizes[0], m.sizes.at(-1), m.again], ['A4 landscape', 'A4', false]);
    if (hasPyMuPDF) assert.equal(m.text, 'narrow');
  });

  test('--scale on a PDF: the paper holds a page as much wider, which its media queries and its window follow; refused out of 0.1 to 2', async () => {
    // A page that turns its paper once laid out on 1200 px or more, and
    // takes its window for title. A4 with its 1 cm margins holds 718 px.
    const page = file('native/scale.html', '<style>@media (min-width: 1200px) { @page { size: A5 landscape } }</style><script>document.title = `${innerWidth} x ${innerHeight}`</script><p>x</p>');
    const out = join(dir, 'native-scale.pdf');
    const made = async (...args: string[]) => {
      const r = await native([...args, page, out]);
      assert.equal(r.code, 0, r.stderr);
      return [await paper(out), (await PDFDocument.load(readFileSync(out), { updateMetadata: false })).getTitle()];
    };
    assert.deepEqual(await made(), ['A4', '794 x 1123']);
    assert.deepEqual(await made('--scale', '1'), ['A4', '794 x 1123']);
    assert.deepEqual(await made('--scale', '0.5'), ['A5 landscape', '1588 x 2246']);
    assert.deepEqual(await made('--scale', '2'), ['A4', '397 x 562']);
    rmSync(out);
    for (const scale of ['0.05', '2.5', 'half']) {
      const r = await native(['--scale', scale, page, out]);
      assert.equal(r.code, 1, scale);
      assert.equal(r.stderr, 'pdfkiln: --scale takes a number from 0.1 to 2 for a PDF\n');
    }
    assert.equal(existsSync(out), false);
  });

  test('--scale on a PDF: the page at its scale inside the margins, which keep their size; a link, a bookmark and a frame of another origin where the page shows them', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const page = file('native/scale-links.html', `<title>T</title><style>body { margin: 0; font: 16px/1.2 sans-serif }</style>
      <p><a href="#t">go</a></p><div style="height: 3000px"></div><h2 id="t" style="margin-left: 200px">Target</h2>`);
    const out = join(dir, 'native-scale-links.pdf');
    // Where the first word stands; the target's page and left edge, and how
    // far from its top the link and the bookmark land.
    const script = `import sys, json, pymupdf
d = pymupdf.open(sys.argv[1])
l = d[0].get_links()[0]
p = d[l["page"]]
w = [w for w in p.get_text("words") if w[4] == "Target"][0]
# PyMuPDF gives named destinations in PDF coordinates.
y = l["to"].y if l["kind"] == 1 else p.rect.height - l["to"].y
b = d.get_toc(False)[0]
print(json.dumps({"go": d[0].get_text("words")[0][:2], "page": l["page"], "x": w[0], "link": abs(w[1] - y), "bookmark": [b[2] - 1, abs(w[1] - b[3]["to"].y)]}))`;
    const cm = 72 / 2.54;
    for (const [scale, at] of [[1, 2], [0.5, 1]] as const) {
      const r = await native(['--outline', '--scale', String(scale), page, out]);
      assert.equal(r.code, 0, r.stderr);
      const m = JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' })) as { go: [number, number]; page: number; x: number; link: number; bookmark: [number, number] };
      const where = `scale ${scale}: ${JSON.stringify(m)}`;
      // The margins: 1 cm, whatever the scale.
      assert.ok(Math.abs(m.go[0] - cm) < 2 && Math.abs(m.go[1] - cm) < 4, where);
      // 3000 px above the target, 200 px on its left: 0.75 pt each at scale 1.
      assert.equal(m.page, at, where);
      assert.ok(Math.abs(m.x - (cm + 200 * 0.75 * scale)) < 2, where);
      assert.ok(m.link < 3, where);
      assert.deepEqual([m.bookmark[0], m.bookmark[1] < 8], [at, true], where);
    }
    // The frame printed apart, drawn at the scale of the page that holds it.
    const frame = async (scale: number) => {
      const pdf = join(dir, `native-scale-frame-${scale}.pdf`);
      const r = await native(['--allow-private-network', '--scale', String(scale), framePage('native/frames/scale.html'), pdf]);
      assert.equal(r.code, 0, r.stderr);
      assertFramePrinted(pdf);
      return firstPage(pdf).blocks.find((b) => b[4].includes('FRAME TEXT'))!;
    };
    const [full, half] = [await frame(1), await frame(0.5)];
    // The frame's text: after the body's 8 px margin and the frame's 3 px
    // border, and half as wide.
    assert.ok(Math.abs(half[0] - (cm + 11 * 0.75 * 0.5)) < 2, JSON.stringify(half));
    assert.ok(Math.abs((half[2] - half[0]) / (full[2] - full[0]) - 0.5) < 0.03, JSON.stringify([full, half]));
  });

  test('pdfkiln wkhtmltopdf switches to the compatible mode', async () => {
    const r = await native(['wkhtmltopdf', '--version']);
    assert.match(r.stdout.toString(), /^wkhtmltopdf 0\.12\.6/);
  });

  test('--help and --version: the name PDFKiln, the command pdfkiln', async () => {
    let r = await native(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^PDFKiln: HTML and Markdown to PDF and images with Chromium\n\nUsage:\n {2}pdfkiln \[options\] <input>\.\.\. <output>\n/);
    assert.match(r.stdout.toString(), /\nImages:\n {2}--to <png\|webp\|jpeg\|pdf> {4}Format of the output/);
    assert.match(r.stdout.toString(), /\n {2}wkhtmltopdf {17}The command line of wkhtmltopdf 0\.12\.6\n/);
    assert.match(r.stdout.toString(), /\nDocument properties \(default: from the front matter of Markdown\):\n {2}--title <text> {14}Title \(default: the page's <title>\)\n/);
    assert.match(r.stdout.toString(), /\n {2}--from markdown {13}Read every input but PDFs as Markdown,\n/);
    // --scale is for a PDF and for an image: with the rendering, not among
    // the options of images.
    assert.match(r.stdout.toString(), /\n {30}image\)\n {2}--scale <factor> {12}Size of a CSS pixel in the output \(default: 1\)\.\n/);
    assert.doesNotMatch(r.stdout.toString(), /\nImages:\n(?: .*\n)*? {2}--scale /);
    assert.match(r.stdout.toString(), /\n {2}--fail-on-resource-error {4}Fail, without a PDF, /);
    // pdfkiln serve is gone (1.2.0).
    assert.doesNotMatch(r.stdout.toString(), /\bserve\b/);
    // Every line fits in 80 columns.
    assert.deepEqual(r.stdout.toString().split('\n').filter((l) => l.length > 80), []);
    r = await native(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^PDFKiln \d+\.\d+\.\d+, Chromium \d+(\.\d+){3}\n$/);
  });

  test('an input is a file unless it is a URL: a missing one is not looked for on the web', async () => {
    let r = await native(['missing.html', join(dir, 'm.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'pdfkiln: error: could not load missing.html: no such file\n');
    // One named like a host was meant as a URL.
    for (const host of ['www.example.com', '10.0.0.5']) {
      r = await native([host, join(dir, 'm.pdf')]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: error: could not load ${host}: no such file (a URL starts with https://)\n`);
    }
    r = await native([dir, join(dir, 'm.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, `pdfkiln: error: could not load ${dir}: not a file\n`);
    // .md is Moldova's domain, but a missing notes.md is a file.
    r = await native(['notes.md', join(dir, 'm.pdf')]);
    assert.equal(r.stderr, 'pdfkiln: error: could not load notes.md: no such file\n');
  });

  test('a frame that waits to be scrolled to holds neither mode', async () => {
    // Up to 1.3.0, Puppeteer waited 30 s for its document at each step that
    // reaches every frame: 30 s in this mode, 60 s in the compatible one.
    const out = join(dir, 'deferred.pdf');
    let r = await native(['--allow-private-network', `${base}/deferred`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 15000, `${Math.round(r.ms)} ms`);
    r = await run([`${base}/deferred`, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 15000, `${Math.round(r.ms)} ms`);
  });

  test('a frame of another origin in a page given as a file is printed, and nothing more goes to its host', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    const out = join(dir, 'native-frame.pdf');
    frameRequests.length = 0;
    // A page from a file has no host: --header and --cookie go nowhere, the
    // frame printed apart included.
    const r = await native(['--allow-private-network', '--header', 'X-Test: secret', '--cookie', 'c=v', framePage('native/frames/page.html'), out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assertFramePrinted(out);
    assert.ok(frameRequests.length > 0 && frameRequests.every((h) => h === 'GET no header, no cookie'), frameRequests.join(' | '));
  });

  test('on Windows, Chromium writes no log beside itself', async (t) => {
    if (process.platform !== 'win32') return t.skip('Windows only');
    const s = await selfSignedServer();
    if (!s) return t.skip('openssl missing');
    const { executablePath } = await import('../src/chromium.js');
    const log = join(dirname(executablePath()), 'debug.log');
    const size = () => (existsSync(log) ? statSync(log).size : -1);
    const before = size();
    try {
      // An image from a server whose certificate does not verify: Chromium
      // logs the failed handshake.
      const r = await native(['--allow-private-network', file('native/log/page.html', `<p>log</p><img src="${s.url}/image">`), join(dir, 'log.pdf')]);
      assert.equal(r.code, 0, r.stderr);
    } finally {
      s.close();
    }
    assert.equal(size(), before, log);
  });

  test('the Referer stays to Chromium\'s policy: the input\'s origin to another site, not its whole address', async () => {
    refSeen = '';
    const r = await native(['--allow-private-network', '--header', 'X-Test: k', `${base}/ref-page?token=T`, join(dir, 'ref.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(refSeen, `${base}/`);
  });

  test('a page the input goes to, that another site sends back to its host, takes neither --header nor --cookie', async () => {
    landingHeader = '';
    const r = await native(['--allow-private-network', '--header', 'X-Test: secret', `${base}/refresh`, join(dir, 'refresh.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(landingHeader, 'no header');
  });

  test('a frame of another origin that waits to be scrolled to, far below, in a page given as a file, is printed in both modes', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    // Up to 1.4.0's review, blank: without a document, it was not marked,
    // and printing loads it in a process of its own.
    const page = file('lazy-frame/page.html', `<div style="height: 20000px"></div><iframe loading="lazy" src="${other}/frame/red" width="400" height="200"></iframe>`);
    const outs = [join(dir, 'lazy-frame-native.pdf'), join(dir, 'lazy-frame-wk.pdf')];
    let r = await native(['--allow-private-network', page, outs[0]!]);
    assert.equal(r.code, 0, r.stderr);
    r = await run(['-q', page, outs[1]!]);
    assert.equal(r.code, 0, r.stderr);
    for (const out of outs) assert.ok(pagesText(out).some((text) => text.includes('FRAME TEXT')), out);
  });

  test('frames left as Chromium leaves them: one that prints nothing, without failing; a sandboxed one, not loaded again', async (t) => {
    if (!hasPyMuPDF) return t.skip('PyMuPDF missing');
    let out = join(dir, 'empty-frame.pdf');
    let r = await native(['--allow-private-network', file('native/frames/empty.html', `<p>Before</p><iframe src="${other}/frame/empty" width="400" height="200"></iframe><p>After</p>`), out]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(firstPage(out).blocks.some((b) => b[4].includes('After')));
    frameRequests.length = 0;
    out = join(dir, 'sandboxed-frame.pdf');
    r = await native(['--allow-private-network', file('native/frames/sandboxed.html', `<p>Before</p><iframe sandbox src="${other}/frame/red" width="400" height="200"></iframe><p>After</p>`), out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(frameRequests.length, 1, frameRequests.join(' | '));
    assert.ok(!firstPage(out).blocks.some((b) => b[4].includes('FRAME TEXT')));
  });

  describe('Markdown', () => {
    const properties = async (out: string) => {
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      return [doc.getTitle(), doc.getAuthor(), doc.getSubject(), doc.getKeywords()];
    };

    test('a .md file: its front matter gives the properties that no option does', async () => {
      const md = file('native/md/report.md', '---\ntitle: Rapport T3\nauthor: Équipe\nsubject: Ventes\nkeywords: [ventes, T3]\nlang: fr\n---\n# Heading\n\ntext\n');
      const out = join(dir, 'md-report.pdf');
      let r = await native([md, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
      assert.deepEqual(await properties(out), ['Rapport T3', 'Équipe', 'Ventes', 'ventes, T3']);
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      assert.equal(String(doc.catalog.get(PDFName.of('Lang'))), '(fr)');
      r = await native(['--title', 'T', '--author', 'A', '--keywords', 'k', md, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await properties(out), ['T', 'A', 'Ventes', 'k']);
      // Without a front matter: the first heading, the file's name otherwise.
      r = await native([file('native/md/plain.md', 'no heading'), out]);
      assert.deepEqual(await properties(out), ['plain', undefined, undefined, undefined]);
    });

    test("links to a heading stay in the PDF, at the heading; none to a local file; --outline from the headings", async () => {
      const md = file('native/md/links.md', `# Top\n\n[Down](#down) and a note[^1], [the guide](guide.md), [again](links.md#down), <a href="../other.md">other</a>, [web](https://example.com/).\n\n${'filler\n\n'.repeat(60)}## Down\n\n[^1]: The note.\n`);
      const out = join(dir, 'md-links.pdf');
      const r = await native(['--outline', md, out]);
      assert.equal(r.code, 0, r.stderr);
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      const annots = doc.getPage(0).node.Annots()!;
      const links = Array.from({ length: annots.size() }, (_, i) => doc.context.lookup(annots.get(i)) as PDFDict);
      const dests = links.map((a) => String(a.get(PDFName.of('Dest')) ?? (a.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI')) as unknown as { decodeText(): string }).decodeText()));
      // The folder's path is in no link: the guide and the other document are text.
      assert.deepEqual(dests, ['/down', '/fn1', '/down', 'https://example.com/']);
      assert.ok(!readFileSync(out).includes('pdfkiln-'), 'no path of the conversion in the PDF');
      assert.ok(doc.catalog.get(PDFName.of('Outlines')));
      if (hasPyMuPDF) {
        const script = 'import sys, json, pymupdf\nd = pymupdf.open(sys.argv[1])\nprint(json.dumps([[t[1], t[2]] for t in d.get_toc()]))';
        const toc = JSON.parse(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' })) as [string, number][];
        assert.deepEqual(toc.map(([t]) => t), ['Top', 'Down']);
        assert.equal(toc[1]![1], doc.getPageCount() - (pagesText(out).at(-1)!.includes('Down') ? 0 : 1));
      }
    });

    test("no JavaScript; images from the document's folder, not from outside", async () => {
      file('native/md/doc/pic.png', 'png');
      file('native/md/outside.png', 'png');
      const md = file('native/md/doc/doc.md', '# Doc\n\n<p id="p">static</p><script>document.getElementById("p").textContent = "script ran"</script>\n\n![in](pic.png) ![out](../outside.png)\n');
      const out = join(dir, 'md-doc.pdf');
      const url = pathToFileURL(join(dir, 'native', 'md', 'outside.png')).href;
      let r = await native([md, out]);
      assert.equal(r.code, 0, r.stderr);
      // pic.png is no PNG: Chromium reads it, and draws nothing; outside.png
      // is not read at all.
      assert.equal(r.stderr, `pdfkiln: warning: could not load ${url}: not an allowed file (--allow <path> or --enable-local-file-access to read it)\n`);
      r = await native(['--fail-on-resource-error', md, out]);
      assert.equal(r.code, 1);
      r = await native(['--allow', join(dir, 'native', 'md'), md, out]);
      assert.equal(r.stderr, '');
      if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /static/);
    });

    test('from an http or https URL: fetched with the input\'s rules, its images from its site', async () => {
      const out = join(dir, 'md-url.pdf');
      const doc = `${base}/md/doc.md`;
      // A private address is refused by default, as for any input.
      let r = await native([doc, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: error: could not load ${doc}: 127.0.0.1 is a private address (--allow-private-network to reach it)\n`);
      // Through a redirect; --header and --cookie go to its host, its image
      // included.
      mdRequest = mdImageRequest = '';
      r = await native(['--allow-private-network', '--header', 'X-Test: md', '--cookie', 'k=v', `${base}/md/moved.md`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
      assert.equal((await properties(out))[0], 'From the web');
      assert.equal(mdRequest, 'md, k=v');
      assert.equal(mdImageRequest, 'md, k=v');
      // A link to the document itself stays in the PDF; one to the web stays.
      const pdf = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      const annots = pdf.getPage(0).node.Annots()!;
      const links = Array.from({ length: annots.size() }, (_, i) => pdf.context.lookup(annots.get(i)) as PDFDict);
      assert.deepEqual(links.map((a) => String(a.get(PDFName.of('Dest')) ?? (a.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI')) as unknown as { decodeText(): string }).decodeText())), ['/install', 'https://example.com/']);
      // --from markdown: a URL of any name.
      r = await native(['--allow-private-network', '--from', 'markdown', `${base}/md/raw-readme`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal((await properties(out))[0], 'Raw readme');
      // An HTTP error is the input's.
      r = await native(['--allow-private-network', `${base}/md/missing.md`, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: error: could not load ${base}/md/missing.md: HTTP 404\n`);
    });

    test('--from markdown: the standard input, a file of any name; not a data: URL', async () => {
      const out = join(dir, 'md-from.pdf');
      let r = await native(['--from', 'markdown', '-', out], '---\ntitle: From stdin\n---\n# x\n');
      assert.equal(r.code, 0, r.stderr);
      assert.equal((await properties(out))[0], 'From stdin');
      const readme = file('native/md/README', '# The readme\n');
      r = await native(['--from', 'markdown', readme, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal((await properties(out))[0], 'The readme');
      // Without it, - is HTML.
      r = await native(['-', out], '<title>HTML</title># not a heading');
      assert.equal((await properties(out))[0], 'HTML');
      r = await native(['--from', 'markdown', 'data:text/plain,%23%20x', out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, 'pdfkiln: could not load data:text/plain,%23%20x: Markdown is read from a file, an http or https URL or the standard input, not from a data: URL\n');
      r = await native(['--from', 'html', readme, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, 'pdfkiln: --from takes markdown\n');
    });

    test('merged with HTML; the properties from the first front matter', async () => {
      const a = file('native/md/a.md', '---\nauthor: First\n---\n# A\n');
      const b = file('native/md/b.md', '---\nauthor: Second\n---\n# B\n');
      const html = file('native/md/c.html', '<p>c</p>');
      const out = join(dir, 'md-merged.pdf');
      const r = await native([html, a, b, out]);
      assert.equal(r.code, 0, r.stderr);
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      assert.equal(doc.getPageCount(), 3);
      assert.equal(doc.getAuthor(), 'First');
    });
  });

  describe('PDF inputs', () => {
    // A PDF made elsewhere: two pages of 400 x 500 pt, a link from the first
    // to the second by an explicit destination, another by a name of its
    // /Names tree, one to the web, bookmarks by a GoTo action and by a
    // name, a script run on opening, and a title.
    const madeElsewhere = async (): Promise<Buffer> => {
      const src = await PDFDocument.create();
      const p1 = src.addPage([400, 500]);
      const p2 = src.addPage([400, 500]);
      const ctx = src.context;
      const link = (o: Record<string, unknown>) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], ...o } as never));
      p1.node.set(PDFName.of('Annots'), ctx.obj([
        link({ Dest: [p2.ref, PDFName.of('XYZ'), 0, 500, 0] }),
        link({ A: { S: 'GoTo', D: PDFString.of('second') } }),
        link({ A: { S: 'URI', URI: PDFString.of('https://example.com/') } }),
      ]));
      src.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: ctx.register(ctx.obj({ Names: [PDFString.of('second'), ctx.obj([p2.ref, PDFName.of('Fit')])] })) }));
      const [one, two, root] = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
      ctx.assign(one, ctx.obj({ Title: PDFHexString.fromText('Part one'), Parent: root, Next: two, A: { S: 'GoTo', D: [p1.ref, PDFName.of('Fit')] } }));
      ctx.assign(two, ctx.obj({ Title: PDFHexString.fromText('Part two'), Parent: root, Prev: one, Dest: PDFString.of('second') }));
      ctx.assign(root, ctx.obj({ Type: 'Outlines', First: one, Last: two, Count: 2 }));
      src.catalog.set(PDFName.of('Outlines'), root);
      src.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));
      src.setTitle('General terms');
      return Buffer.from(await src.save());
    };
    // Each page's size, where each link goes, the bookmarks, the title,
    // pages left outside the page tree, and what the catalog took from the
    // inputs.
    const contents = async (f: string) => {
      const doc = await PDFDocument.load(readFileSync(f), { updateMetadata: false });
      const pages = doc.getPages();
      const at = (ref: unknown) => `p${pages.findIndex((p) => p.ref.toString() === String(ref)) + 1}`;
      const dests = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
      const links: string[] = [];
      pages.forEach((p, i) => {
        const annots = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
        for (let k = 0; annots && k < annots.size(); k++) {
          const a = annots.lookup(k, PDFDict);
          const d = a.get(PDFName.of('Dest'));
          const named = d instanceof PDFName ? dests?.lookupMaybe(d, PDFArray) : undefined;
          const uri = a.lookupMaybe(PDFName.of('A'), PDFDict)?.lookup(PDFName.of('URI'));
          const to = d instanceof PDFArray ? at(d.get(0)) : named ? at(named.get(0)) : uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : '?';
          links.push(`p${i + 1} ${to}`);
        }
      });
      const outline: string[] = [];
      const walk = (d: PDFDict | undefined): void => {
        for (; d; d = d.lookupMaybe(PDFName.of('Next'), PDFDict)) {
          outline.push(`${(d.lookup(PDFName.of('Title')) as PDFHexString).decodeText()} ${at(d.lookup(PDFName.of('Dest'), PDFArray).get(0))}`);
          walk(d.lookupMaybe(PDFName.of('First'), PDFDict));
        }
      };
      walk(doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)?.lookupMaybe(PDFName.of('First'), PDFDict));
      const tree = new Set(pages.map((p) => p.ref.toString()));
      const astray = doc.context.enumerateIndirectObjects().filter(([r, o]) => o instanceof PDFDict && o.lookup(PDFName.of('Type')) === PDFName.of('Page') && !tree.has(r.toString())).length;
      return {
        sizes: pages.map((p) => `${Math.round(p.getWidth())} x ${Math.round(p.getHeight())}`),
        links, outline, title: doc.getTitle(), astray,
        catalog: ['OpenAction', 'Names', 'AcroForm'].filter((k) => doc.catalog.has(PDFName.of(k))),
      };
    };
    const A4 = '596 x 842';
    const CARD = '400 x 500';

    test('a PDF after the page or before it: its pages as they are, its links and bookmarks kept, its catalog left', async () => {
      const terms = join(dir, 'native-terms.pdf');
      writeFileSync(terms, await madeElsewhere());
      const page = file('native/pdf/invoice.html', '<title>Invoice 42</title><h1>Invoice</h1><a href="#total">to the total</a><p id="total" style="margin-top: 1500px">Total</p>');
      const out = join(dir, 'with-terms.pdf');
      let r = await native(['--outline', page, terms, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
      assert.deepEqual(await contents(out), {
        sizes: [A4, A4, CARD, CARD],
        links: ['p1 p2', 'p3 p4', 'p3 p4', 'p3 https://example.com/'],
        outline: ['Invoice p1', 'Part one p3', 'Part two p4'],
        title: 'Invoice 42', astray: 0, catalog: [],
      });
      // First, the PDF gives the title, and its script on opening stays out.
      r = await native([terms, page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await contents(out), {
        sizes: [CARD, CARD, A4, A4],
        links: ['p1 p2', 'p1 p2', 'p1 https://example.com/', 'p3 p4'],
        outline: [],
        title: 'General terms', astray: 0, catalog: [],
      });
    });

    test('PDFs alone: merged without Chromium', async () => {
      const terms = join(dir, 'native-terms.pdf');
      writeFileSync(terms, await madeElsewhere());
      const out = join(dir, 'pdfs-alone.pdf');
      // A Chromium that cannot start: a conversion that started it fails.
      const r = await native([terms, terms, out], '', { PDFKILN_CHROMIUM: join(dir, 'no-chromium', 'chrome') });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual((await contents(out)).sizes, [CARD, CARD, CARD, CARD]);
      assert.deepEqual((await contents(out)).links, ['p1 p2', 'p1 p2', 'p1 https://example.com/', 'p3 p4', 'p3 p4', 'p3 https://example.com/']);
    });

    test('a PDF from a URL: fetched under the rules of a page', async () => {
      servedPdf = await madeElsewhere();
      const page = file('native/pdf/short.html', '<p>Invoice</p>');
      const out = join(dir, 'url-terms.pdf');
      let r = await native(['--allow-private-network', page, `${base}/terms.pdf`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual((await contents(out)).sizes, [A4, CARD, CARD]);
      r = await native([page, `${base}/terms.pdf`, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: error: could not load ${base}/terms.pdf: 127.0.0.1 is a private address (--allow-private-network to reach it)\n`);
      r = await native(['--allow-private-network', page, `${base}/fake.pdf`, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: error: could not load ${base}/fake.pdf: not a PDF\n`);
      r = await native(['--allow-private-network', page, `${base}/missing.pdf`, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: error: could not load ${base}/missing.pdf: HTTP 404\n`);
    });

    test('refused: a PDF that is encrypted or not one; one not PDF/A with --pdfa or --factur-x; with --tagged, or for an image', async () => {
      const terms = join(dir, 'native-terms.pdf');
      writeFileSync(terms, await madeElsewhere());
      const locked = await PDFDocument.create();
      locked.addPage([200, 200]);
      locked.encrypt({ userPassword: 'secret', ownerPassword: 'owner', permissions: {} });
      const lockedFile = join(dir, 'native-locked.pdf');
      writeFileSync(lockedFile, await locked.save());
      const page = file('native/pdf/refused.html', '<p>x</p>');
      const out = join(dir, 'refused-pdf.pdf');
      const cases: [string[], string][] = [
        [[page, lockedFile, out], `pdfkiln: error: could not load ${lockedFile}: the PDF is encrypted, and PDFKiln does not remove its password or restrictions\n`],
        [[page, file('native/pdf/fake.pdf', '<p>not a PDF</p>'), out], `pdfkiln: error: could not load ${join(dir, 'native/pdf/fake.pdf')}: not a PDF\n`],
        [[page, 'missing.pdf', out], 'pdfkiln: error: could not load missing.pdf: no such file\n'],
        [['--pdfa', page, terms, out], `pdfkiln: --pdfa: ${terms} is not PDF/A, and PDFKiln cannot check that a PDF made elsewhere conforms: export it as PDF/A where it is made (PDF/A-2b or 3b)\n`],
        [['--factur-x', invoiceXml, page, terms, out], `pdfkiln: --factur-x: ${terms} is not PDF/A, and PDFKiln cannot check that a PDF made elsewhere conforms: export it as PDF/A where it is made (PDF/A-2b or 3b)\n`],
        [['--tagged', terms, out], `pdfkiln: --tagged takes an HTML or Markdown input, not a PDF (${terms})\n`],
        [[terms, join(dir, 'refused-pdf.png')], `pdfkiln: an image is made from HTML or Markdown, not from a PDF (${terms})\n`],
      ];
      for (const [args, message] of cases) {
        const r = await native(args);
        assert.equal(r.code, 1, args.join(' '));
        assert.equal(r.stderr, message);
      }
      assert.equal(existsSync(out), false);
      // On the standard input, a PDF would be printed as text.
      const r = await native(['-', out], await madeElsewhere());
      assert.equal(r.code, 1);
      assert.equal(r.stderr, 'pdfkiln: error: could not load -: the standard input is a PDF: give it as a file named .pdf\n');
    });

    test('with --pdfa or --factur-x, a PDF that is PDF/A itself, for the screen, of a part the level takes', async () => {
      const page = file('native/pdf/archived.html', '<style>body { font-family: "Liberation Sans", Arial, sans-serif }</style><h1>Facture 2026/11/000042</h1>');
      const annex2b = join(dir, 'annex-2b.pdf');
      const annex3b = join(dir, 'annex-3b.pdf');
      let r = await native(['--pdfa=2b', page, annex2b]);
      assert.equal(r.code, 0, r.stderr);
      r = await native(['--pdfa=3b', page, annex3b]);
      assert.equal(r.code, 0, r.stderr);
      const out = join(dir, 'archived-with-annex.pdf');
      r = await native(['--pdfa', page, annex2b, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await archived(out), { part: '3', conformance: 'B', files: [] });
      r = await native(['--factur-x', invoiceXml, page, annex3b, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await archived(out), { part: '3', conformance: 'B', files: ['factur-x.xml /Data'] });
      r = await native(['--pdfa=2u', annex2b, page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await archived(out), { part: '2', conformance: 'U', files: [] });
      // PDF/A-3 into PDF/A-2: its catalog's attachments stay out, one on a
      // page would not.
      r = await native(['--pdfa=2b', page, annex3b, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await archived(out), { part: '2', conformance: 'B', files: [] });
      const attached = await PDFDocument.load(readFileSync(annex3b), { updateMetadata: false });
      attached.getPage(0).node.set(PDFName.of('Annots'), attached.context.obj([attached.context.register(attached.context.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [0, 0, 10, 10] }))]));
      const annexAttached = join(dir, 'annex-attached.pdf');
      writeFileSync(annexAttached, await attached.save());
      rmSync(out);
      r = await native(['--pdfa=2b', page, annexAttached, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: --pdfa: ${annexAttached} is PDF/A-3 with a file attached to its pages, which PDF/A-2 forbids: ask --pdfa for 3b or 3u\n`);
      // PDF/A for print, its output intent in CMYK.
      const print = await PDFDocument.load(readFileSync(annex2b), { updateMetadata: false });
      const intent = print.catalog.lookup(PDFName.of('OutputIntents'), PDFArray).lookup(0, PDFDict);
      intent.lookup(PDFName.of('DestOutputProfile'), PDFStream).dict.set(PDFName.of('N'), print.context.obj(4));
      const cmyk = join(dir, 'annex-cmyk.pdf');
      writeFileSync(cmyk, await print.save());
      r = await native(['--pdfa', page, cmyk, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: --pdfa: ${cmyk} is PDF/A for print, in CMYK, and the PDF/A PDFKiln writes is in sRGB: export it for the screen (RGB)\n`);
      // Declared PDF/A, its font not embedded: the check of the fonts sees it.
      const fake = await PDFDocument.create();
      fake.addPage([200, 200]).drawText('x', { font: await fake.embedFont(StandardFonts.Helvetica) });
      fake.convertToPDFA({ conformance: '2B' });
      const fakeFile = join(dir, 'annex-fake.pdf');
      writeFileSync(fakeFile, await fake.save());
      r = await native(['--pdfa', page, fakeFile, out]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^pdfkiln: error: --pdfa: a font is not embedded in the PDF \(Helvetica\)/);
      assert.equal(existsSync(out), false);
    });

    test('--from markdown leaves a PDF a PDF', async () => {
      const terms = join(dir, 'native-terms.pdf');
      writeFileSync(terms, await madeElsewhere());
      const notes = file('native/pdf/notes.txt', '# Notes\n\ntext\n');
      const out = join(dir, 'md-terms.pdf');
      const r = await native(['--from', 'markdown', notes, terms, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual((await contents(out)).sizes, [A4, CARD, CARD]);
    });

    test('a PDF input that loops or carries scripts: read once, its pages without their scripts and attachments', async () => {
      // A /Names /Dests node listed twice under itself, an outline item that
      // is its own /Next, a folder without a destination; on its page, a
      // script run on opening, a link to a script, a file attached, and a
      // link whose /P names its page.
      const src = await PDFDocument.create();
      const p1 = src.addPage([400, 500]);
      const p2 = src.addPage([400, 500]);
      const ctx = src.context;
      const tree = ctx.nextRef();
      ctx.assign(tree, ctx.obj({ Kids: [ctx.register(ctx.obj({ Names: [PDFString.of('second'), ctx.obj([p2.ref, PDFName.of('Fit')])] })), tree, tree] }));
      src.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: tree }));
      const link = (o: Record<string, unknown>) => ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], ...o } as never));
      p1.node.set(PDFName.of('AA'), ctx.obj({ O: { S: 'JavaScript', JS: PDFString.of('app.alert(1)') } }));
      p1.node.set(PDFName.of('Annots'), ctx.obj([
        link({ A: { S: 'GoTo', D: PDFString.of('second') }, P: p1.ref }),
        link({ A: { S: 'JavaScript', JS: PDFString.of('app.alert(2)') } }),
        ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [60, 0, 80, 20], FS: { Type: 'Filespec', F: PDFString.of('a.txt') } } as never)),
      ]));
      const [folder, a, b, loop, root] = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
      ctx.assign(folder, ctx.obj({ Title: PDFHexString.fromText('Folder'), Parent: root, Next: loop, First: a, Last: b }));
      ctx.assign(a, ctx.obj({ Title: PDFHexString.fromText('A'), Parent: folder, Next: b, Dest: [p1.ref, PDFName.of('Fit')] }));
      ctx.assign(b, ctx.obj({ Title: PDFHexString.fromText('B'), Parent: folder, Prev: a, Dest: PDFString.of('second') }));
      ctx.assign(loop, ctx.obj({ Title: PDFHexString.fromText('Loop'), Parent: root, Prev: folder, Next: loop, Dest: [p2.ref, PDFName.of('Fit')] }));
      ctx.assign(root, ctx.obj({ Type: 'Outlines', First: folder, Last: loop }));
      src.catalog.set(PDFName.of('Outlines'), root);
      const pdf = join(dir, 'native/pdf/hostile.pdf');
      mkdirSync(join(dir, 'native/pdf'), { recursive: true });
      writeFileSync(pdf, await src.save());
      const out = join(dir, 'hostile-out.pdf');
      const r = await native(['--outline', '--timeout', '20', pdf, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.ms < 15000, `${Math.round(r.ms)} ms`);
      const c = await contents(out);
      assert.deepEqual(c.outline, ['Folder p1', 'A p1', 'B p2', 'Loop p2']);
      assert.deepEqual(c.links, ['p1 p2']);
      assert.equal(c.astray, 0);
      const doc = await PDFDocument.load(readFileSync(out), { updateMetadata: false });
      assert.equal(doc.getPage(0).node.has(PDFName.of('AA')), false);
      // Viewers show the title, the document starting with a PDF.
      assert.equal(String(doc.catalog.lookup(PDFName.of('ViewerPreferences'), PDFDict).get(PDFName.of('DisplayDocTitle'))), 'true');
    });
  });

  describe('passwords', () => {
    // The encryption of a PDF: its handler's version and revision, and the
    // rights of whoever opens it without the owner's password (ISO 32000-1,
    // table 22: print 3, modify 4, copy 5, annotate 6, fill forms 9,
    // accessibility 10, assemble 11, print in high quality 12).
    const encryption = async (f: string) => {
      const doc = await PDFDocument.load(readFileSync(f), { ignoreEncryption: true, updateMetadata: false });
      const e = doc.context.lookup(doc.context.trailerInfo.Encrypt, PDFDict);
      const n = (k: string) => Number(String(e.get(PDFName.of(k))));
      const bits: Record<string, number> = { print: 3, modify: 4, copy: 5, annotate: 6, forms: 9, accessibility: 10, assemble: 11, 'print-hq': 12 };
      return { v: n('V'), r: n('R'), denied: Object.keys(bits).filter((k) => !(n('P') & (1 << (bits[k]! - 1)))) };
    };
    const page = () => file('native/pw/slip.html', '<title>Bulletin de paie</title><h1>Bulletin de paie novembre 2026</h1>');

    test('--user-password: AES-256, the PDF opened with it only, every right given', async () => {
      const out = join(dir, 'pw-user.pdf');
      const r = await native(['--user-password', 'secret', page(), out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await encryption(out), { v: 5, r: 6, denied: [] });
      await assert.rejects(PDFDocument.load(readFileSync(out)), /encrypted/);
      assert.equal((await PDFDocument.load(readFileSync(out), { password: 'secret', updateMetadata: false })).getPageCount(), 1);
      if (hasPyMuPDF) {
        const script = 'import sys, pymupdf\nd = pymupdf.open(sys.argv[1])\nprint(d.needs_pass, d.authenticate("wrong"), d.authenticate("secret") > 0, d.metadata["title"], "/", d[0].get_text().split(chr(10))[0])';
        assert.equal(execFileSync(python, ['-I', '-c', script, out], { encoding: 'utf8' }).trim(), '1 0 True Bulletin de paie / Bulletin de paie novembre 2026');
      }
    });

    test('the strings of the catalog and of the pages are encrypted too, and read back', async () => {
      // A tagged page in French, whose language Chromium writes in the
      // catalog, and a PDF input whose link is written in its page.
      const src = await PDFDocument.create({ updateMetadata: false });
      const p = src.addPage([300, 300]);
      p.node.set(PDFName.of('Annots'), src.context.obj([src.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], A: { S: 'URI', URI: PDFString.of('https://example.com/terms') } } as never)]));
      const terms = join(dir, 'native/pdf/inline-link.pdf');
      mkdirSync(join(dir, 'native/pdf'), { recursive: true });
      writeFileSync(terms, await src.save());
      const out = join(dir, 'strings.pdf');
      const r = await native(['--outline', '--user-password', 'u', '--owner-password', 'o', file('native/pw/fr.html', '<html lang="fr"><h1>Bonjour</h1></html>'), terms, out]);
      assert.equal(r.code, 0, r.stderr);
      const text = readFileSync(out).toString('latin1');
      assert.ok(!/\/Lang\s*\(fr\)/.test(text) && !text.includes('https://example.com/terms'), 'a string in clear');
      const doc = await PDFDocument.load(readFileSync(out), { password: 'u', updateMetadata: false });
      assert.equal((doc.catalog.lookup(PDFName.of('Lang')) as PDFString).decodeText(), 'fr');
      const annots = doc.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
      assert.equal((annots.lookup(0, PDFDict).lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI')) as PDFString).decodeText(), 'https://example.com/terms');
    });

    test('--owner-password with --no-print, --no-copy, --no-modify: the rights of the others', async () => {
      const out = join(dir, 'pw-owner.pdf');
      let r = await native(['--user-password', 'secret', '--owner-password', 'boss', '--no-print', '--no-copy', page(), out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await encryption(out), { v: 5, r: 6, denied: ['print', 'copy', 'print-hq'] });
      // Opened without a password, nothing changed in it.
      r = await native(['--owner-password', 'boss', '--no-modify', page(), out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await encryption(out), { v: 5, r: 6, denied: ['modify', 'annotate', 'forms', 'assemble'] });
      assert.equal((await PDFDocument.load(readFileSync(out), { password: '', updateMetadata: false })).getPageCount(), 1);
    });

    test('refused: a restriction without --owner-password, the same password twice, an empty one, with --pdfa, for an image', async () => {
      const out = join(dir, 'pw-refused.pdf');
      const cases: [string[], string][] = [
        [['--user-password', 'secret', '--no-copy', page(), out], 'pdfkiln: --no-copy needs --owner-password: without it, whoever opens the PDF may lift the restriction\n'],
        [['--user-password', 'same', '--owner-password', 'same', page(), out], 'pdfkiln: --owner-password must differ from --user-password, or it gives every right to whoever opens the PDF\n'],
        [['--user-password=', page(), out], 'pdfkiln: --user-password takes a password\n'],
        [['--pdfa', '--user-password', 'secret', page(), out], 'pdfkiln: --pdfa and --user-password do not go together: PDF/A forbids encryption\n'],
        [['--factur-x', invoiceXml, '--owner-password', 'boss', page(), out], 'pdfkiln: --factur-x and --owner-password do not go together: PDF/A forbids encryption\n'],
        [['--no-print', page(), join(dir, 'pw-refused.png')], 'pdfkiln: --no-print is for a PDF, not an image\n'],
      ];
      for (const [args, message] of cases) {
        const r = await native(args);
        assert.equal(r.code, 1, args.join(' '));
        assert.equal(r.stderr, message);
      }
      assert.equal(existsSync(out), false);
    });
  });

  describe('images', () => {
    // A PNG, WebP or JPEG image's format and size, from its header; whether
    // it has alpha, and for WebP whether it is lossless.
    interface Shot { format: string; width: number; height: number; alpha?: boolean; lossless?: boolean }
    const shot = (b: Buffer): Shot => {
      if (b.toString('latin1', 1, 4) === 'PNG') return { format: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20), alpha: b[25] === 6 };
      if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
        // Chromium writes the extended header, its sRGB profile, then the
        // image: VP8L when lossless, VP8 (after ALPH, with alpha) when lossy.
        assert.equal(b.toString('latin1', 12, 16), 'VP8X');
        const chunks: string[] = [];
        for (let i = 12; i + 8 <= b.length; i += 8 + b.readUInt32LE(i + 4) + (b.readUInt32LE(i + 4) & 1)) chunks.push(b.toString('latin1', i, i + 4));
        return { format: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), alpha: Boolean(b[20]! & 0x10), lossless: chunks.includes('VP8L') };
      }
      if (b[0] === 0xff && b[1] === 0xd8) {
        for (let i = 2; i + 9 < b.length; i += 2 + b.readUInt16BE(i + 2)) {
          if (b[i + 1]! >= 0xc0 && b[i + 1]! <= 0xc2) return { format: 'jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
      }
      return { format: 'unknown', width: 0, height: 0 };
    };
    // The colour of each pixel of a PNG, as #rrggbb, or transparent.
    const pixels = async (png: Buffer): Promise<(x: number, y: number) => string> => {
      const { decodePng } = await import('../src/engine/raster.js');
      const r = decodePng(png);
      return (x, y) => {
        const o = (y * r.width + x) * 4;
        return r.rgba[o + 3] === 0 ? 'transparent' : `#${[...r.rgba.subarray(o, o + 3)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
      };
    };

    test('an output named .png: the whole page, in a window 1280 px wide, in screen media; - with --to', async () => {
      // A block as high as the window, then the rest of the page.
      const page = file('native/image/page.html', '<style>body { margin: 0 } .hero { height: 100vh; background: #c00 } .rest { height: 1500px } @media print { .hero { background: #00c } }</style><div class="hero"></div><div class="rest"></div>');
      const out = join(dir, 'page.png');
      let r = await native([page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
      let png = readFileSync(out);
      assert.deepEqual(shot(png), { format: 'png', width: 1280, height: 2220, alpha: false });
      // The block keeps the window's height, 720 px: the page is not laid
      // out in a window as high as itself.
      const at = await pixels(png);
      assert.deepEqual([at(10, 0), at(10, 719), at(10, 720)], ['#cc0000', '#cc0000', '#ffffff']);
      r = await native(['--media', 'print', page, out]);
      png = readFileSync(out);
      assert.equal((await pixels(png))(10, 0), '#0000cc');
      // The standard output, in WebP: lossless.
      r = await native(['--to', 'webp', page, '-']);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(shot(r.stdout), { format: 'webp', width: 1280, height: 2220, alpha: false, lossless: true });
      // --to wins over the name; - is a PDF without it.
      r = await native(['--to', 'pdf', page, join(dir, 'page-pdf.png')]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(readFileSync(join(dir, 'page-pdf.png')).toString('latin1', 0, 5), '%PDF-');
      r = await native([page, '-']);
      assert.equal(r.stdout.toString('latin1', 0, 5), '%PDF-');
    });

    test('--width and --height: the window alone; --scale; --element', async () => {
      const page = file('native/image/box.html', '<style>body { margin: 0 } #box { width: 100px; height: 50px; margin: 20px; background: #08f } @media (max-width: 500px) { #box { background: #f80 } }</style><div id="box"></div><div style="height: 3000px"></div>');
      const out = join(dir, 'box.png');
      let r = await native(['--width', '400', '--height', '300', page, out]);
      assert.equal(r.code, 0, r.stderr);
      let png = readFileSync(out);
      assert.deepEqual(shot(png), { format: 'png', width: 400, height: 300, alpha: false });
      // The page's media queries see the window.
      assert.equal((await pixels(png))(30, 30), '#ff8800');
      r = await native(['--width', '400', '--height', '300', '--scale', '2', page, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(shot(readFileSync(out)), { format: 'png', width: 800, height: 600, alpha: false });
      r = await native(['--element', '#box', '--scale', '2', page, out]);
      assert.equal(r.code, 0, r.stderr);
      png = readFileSync(out);
      assert.deepEqual(shot(png), { format: 'png', width: 200, height: 100, alpha: false });
      assert.equal((await pixels(png))(100, 50), '#0088ff');
      rmSync(out);
      r = await native(['--element', '#missing', page, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, 'pdfkiln: error: no element matches #missing (--element)\n');
      assert.equal(existsSync(out), false);
      r = await native(['--element', '[', page, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, 'pdfkiln: error: --element takes a CSS selector, not [\n');
    });

    test('WebP lossless unless --quality; JPEG; --transparent', async () => {
      const page = file('native/image/clear.html', '<style>body { margin: 0 } div { width: 50px; height: 50px; background: #08f }</style><div></div>');
      const size = ['--width', '200', '--height', '100'];
      const webp = join(dir, 'clear.webp');
      let r = await native([...size, page, webp]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(shot(readFileSync(webp)), { format: 'webp', width: 200, height: 100, alpha: false, lossless: true });
      r = await native([...size, '--quality', '80', page, webp]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(shot(readFileSync(webp)), { format: 'webp', width: 200, height: 100, alpha: false, lossless: false });
      r = await native([...size, '--transparent', page, webp]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(shot(readFileSync(webp)), { format: 'webp', width: 200, height: 100, alpha: true, lossless: true });
      for (const name of ['clear.jpg', 'clear.JPEG']) {
        r = await native([...size, page, join(dir, name)]);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(shot(readFileSync(join(dir, name))), { format: 'jpeg', width: 200, height: 100 });
      }
      const png = join(dir, 'clear.png');
      r = await native([...size, '--transparent', page, png]);
      assert.equal(r.code, 0, r.stderr);
      const at = await pixels(readFileSync(png));
      assert.deepEqual([at(10, 10), at(100, 50)], ['#0088ff', 'transparent']);
    });

    test('refused before the render: the options of a PDF for an image, those of an image for a PDF, two inputs', async () => {
      const page = file('native/image/refused.html', '<p>x</p>');
      const png = join(dir, 'refused.png');
      const jpg = join(dir, 'refused.jpg');
      const forImages = 'is for an image: an output named .png, .webp, .jpg or .jpeg, or --to';
      const cases: [string[], string][] = [
        [['--outline', page, png], 'pdfkiln: --outline is for a PDF, not an image\n'],
        [['--pdfa', page, png], 'pdfkiln: --pdfa is for a PDF, not an image\n'],
        [['--title', 'T', page, png], 'pdfkiln: --title is for a PDF, not an image\n'],
        [['--width', '300', page, join(dir, 'refused.pdf')], `pdfkiln: --width ${forImages}\n`],
        [['--transparent', page, '-'], `pdfkiln: --transparent ${forImages}\n`],
        [[page, page, png], 'pdfkiln: an image takes one input\n'],
        [['--to', 'gif', page, png], 'pdfkiln: --to takes png, webp, jpeg or pdf\n'],
        [['--quality', '80', page, png], 'pdfkiln: --quality is for JPEG and WebP: PNG is lossless\n'],
        [['--transparent', page, jpg], 'pdfkiln: --transparent is for PNG and WebP: JPEG has no transparency\n'],
        [['--quality', '0', page, jpg], 'pdfkiln: --quality takes a number from 1 to 100\n'],
        [['--width', '12.5', page, png], 'pdfkiln: --width takes a number of pixels\n'],
        [['--scale', '0', page, png], 'pdfkiln: --scale takes a number greater than 0\n'],
      ];
      for (const [args, message] of cases) {
        const r = await native(args);
        assert.equal(r.code, 1, args.join(' '));
        assert.equal(r.stderr, message);
      }
      assert.equal(existsSync(png), false);
    });

    test('the whole page: the images and frames that wait to be scrolled to are loaded', async () => {
      const out = join(dir, 'deferred.png');
      const r = await native(['--allow-private-network', `${base}/deferred`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.ms < 15000, `${Math.round(r.ms)} ms`);
      const png = readFileSync(out);
      assert.deepEqual(shot(png), { format: 'png', width: 1280, height: 8400, alpha: false });
      // The image, then the frame.
      const at = await pixels(png);
      assert.deepEqual([at(100, 8100), at(100, 8300)], ['#00ff00', '#00ff00']);
    });

    test('a deferred frame that loads no document, a 204 or a download, holds neither an image nor a PDF', async () => {
      // Up to 1.4.0's review, the image waited for its load event until --timeout.
      let r = await native(['--allow-private-network', '--timeout', '20', `${base}/deferred-empty`, join(dir, 'deferred-empty.png')]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.ms < 15000, `${Math.round(r.ms)} ms`);
      const page = file('deferred-empty/page.html', `<div style="height: 20000px"></div><iframe loading="lazy" src="${other}/no-content"></iframe><iframe loading="lazy" src="${other}/attachment"></iframe>`);
      r = await native(['--allow-private-network', '--timeout', '20', page, join(dir, 'deferred-empty.pdf')]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.ms < 15000, `${Math.round(r.ms)} ms`);
      r = await run(['-q', '--kiln-timeout', '20', page, join(dir, 'deferred-empty-wk.pdf')]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.ms < 15000, `${Math.round(r.ms)} ms`);
    });

    test('a frame that another site sends to the input\u2019s host takes neither --header nor --cookie there, loaded apart too', async () => {
      frameRequests.length = 0;
      const out = join(dir, 'frame-redirect.png');
      const r = await native(['--allow-private-network', '--header', 'X-Test: secret', '--cookie', 'c=v', `${base}/frame-below-redirect`, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal((await pixels(readFileSync(out)))(300, 2150), '#cc0000');
      // An empty Cookie keeps Chromium from adding the input's.
      assert.ok(frameRequests.length > 0 && frameRequests.every((h) => /^GET no header, (no cookie)?$/.test(h)), frameRequests.join(' | '));
    });

    test('a frame of another origin below the window is painted, in a page from a file or from its address', async () => {
      const page = file('native/image/frame-below.html', `<style>body { margin: 0 }</style><div style="height: 2000px"></div><iframe src="${other}/frame/red" width="400" height="200" style="display: block; border: 0"></iframe><div style="height: 300px"></div>`);
      const out = join(dir, 'frame-below.png');
      for (const input of [page, `${base}/frame-below`]) {
        const r = await native(['--allow-private-network', input, out]);
        assert.equal(r.code, 0, r.stderr);
        const png = readFileSync(out);
        assert.deepEqual(shot(png), { format: 'png', width: 1280, height: 2500, alpha: false }, input);
        // Below the frame's text, its background; beside it, the page's.
        const at = await pixels(png);
        assert.deepEqual([at(300, 2150), at(500, 2150)], ['#cc0000', '#ffffff'], input);
      }
    });

    test('no image of an input that does not load, nor with --fail-on-resource-error of one that misses an image', async () => {
      const out = join(dir, 'failed.png');
      let r = await native(['missing.html', out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, 'pdfkiln: error: could not load missing.html: no such file\n');
      const page = file('native/image/broken.html', `<img src="${base}/404">`);
      r = await native(['--allow-private-network', '--fail-on-resource-error', page, out]);
      assert.equal(r.code, 1);
      assert.equal(r.stderr, `pdfkiln: error: could not load ${base}/404: HTTP 404\n`);
      assert.equal(existsSync(out), false);
    });

    test('Markdown with --transparent: no white of its own behind the text', async () => {
      const out = join(dir, 'notes-clear.png');
      const r = await native(['--transparent', file('native/image/clear.md', '# Clear\n'), out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal((await pixels(readFileSync(out)))(5, 5), 'transparent');
    });

    test('Markdown: in a column, as GitHub shows a README', async () => {
      const md = file('native/image/notes.md', '# Notes\n\nSome text.\n');
      const out = join(dir, 'notes.png');
      const r = await native([md, out]);
      assert.equal(r.code, 0, r.stderr);
      const { decodePng } = await import('../src/engine/raster.js');
      const img = decodePng(readFileSync(out));
      // The leftmost dark pixel: the column's margin, (1280 - 980) / 2 + 45.
      let left = img.width;
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < left; x++) {
          if (img.rgba[(y * img.width + x) * 4]! < 128) {
            left = x;
            break;
          }
        }
      }
      assert.ok(left >= 193 && left <= 200, `text from x = ${left}`);
    });
  });
});

describe('wkhtmltoimage', () => {
  const exe = bundled ? join(root, 'dist', 'bundle', 'wkhtmltoimage.cjs') : join(root, 'dist', 'src', 'bin', 'wkhtmltoimage.js');
  const image = (args: string[], stdin = ''): Promise<Run> => new Promise((ok) => {
    const t0 = performance.now();
    const child = spawn(...command(process.env.PDFKILN_TEST_WKHTMLTOIMAGE, exe, args), { cwd: dir });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => ok({ code, stdout: Buffer.concat(out), stderr: err, ms: performance.now() - t0 }));
    child.stdin.end(stdin);
  });
  const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];
  const page = file('image/page.html', '<body style="margin:0"><div style="height:240px;background:#336">Image</div></body>');

  test('the screen width, the height of the content; standard output in JPEG', async () => {
    const out = join(dir, 'page.png');
    let r = await image(['-q', page, out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(pngSize(readFileSync(out)), [1024, 240]);
    r = await image(['-q', '-', '-'], '<p>From stdin</p>');
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual([...r.stdout.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    r = await image(['--version']);
    assert.match(r.stdout.toString(), /^wkhtmltoimage 0\.12\.6 \(with patched qt\), pdfkiln /);
  });

  test('--width, smart width, --height and cropping', async () => {
    const wide = file('image/wide.html', '<body style="margin:0"><div style="width:1500px;height:50px">wide</div></body>');
    const out = join(dir, 'size.png');
    assert.equal((await image(['-q', wide, out])).code, 0);
    const [w] = pngSize(readFileSync(out));
    assert.ok(w! >= 1500 && w! <= 1511, `smart width ${w}`);
    assert.equal((await image(['-q', '--width', '600', '--disable-smart-width', '--height', '300', wide, out])).code, 0);
    assert.deepEqual(pngSize(readFileSync(out)), [600, 300]);
    assert.equal((await image(['-q', '--crop-x', '10', '--crop-y', '5', '--crop-w', '100', '--crop-h', '50', page, out])).code, 0);
    assert.deepEqual(pngSize(readFileSync(out)), [100, 50]);
    const r = await image(['--crop-x', '5000', page, out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Will not output an empty image/);
  });

  test('formats: from the extension or --format; transparency in PNG', async () => {
    const bmp = join(dir, 'page.bmp');
    assert.equal((await image(['-q', page, bmp])).code, 0);
    const b = readFileSync(bmp);
    assert.equal(b.toString('latin1', 0, 2), 'BM');
    assert.deepEqual([b.readInt32LE(18), b.readInt32LE(22), b.readUInt16LE(28)], [1024, 240, 24]);
    const svg = join(dir, 'page.out');
    assert.equal((await image(['-q', '-f', 'svg', page, svg])).code, 0);
    assert.match(readFileSync(svg, 'utf8'), /<svg [^>]*width="1024" height="240"/);
    const gif = join(dir, 'page.gif');
    const r = await image([page, gif]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Could not save image/);
    const clear = file('image/clear.html', '<body style="margin:0"><div style="height:20px"></div></body>');
    const png = join(dir, 'clear.png');
    assert.equal((await image(['-q', '--transparent', clear, png])).code, 0);
    const { decodePng } = await import('../src/engine/raster.js');
    assert.equal(decodePng(readFileSync(png)).rgba[3], 0);
  });

  test('a self-signed certificate is ignored, with a warning per connection, as wkhtmltoimage 0.12.6', async (t) => {
    const s = await selfSignedServer();
    if (!s) return t.skip('openssl missing');
    try {
      const out = join(dir, 'self-signed.jpg');
      let r = await image(['--log-level', 'warn', '--format', 'jpg', '--quality', '100', s.url, out]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, 'Warning: SSL error ignored\n'.repeat(3));
      assert.equal(readFileSync(out).toString('latin1', 0, 2), '\xff\xd8');
      r = await image(['-q', '--kiln-block-invalid-certificates', s.url, out]);
      assert.equal(r.code, 1);
      assert.equal(lastLine(r.stderr), 'Exit with code 1 due to network error: SslHandshakeFailedError');
    } finally {
      s.close();
    }
  });
});

describe('pdfkiln serve, removed in 1.2.0', () => {
  const pdfkiln = bundled ? join(root, 'dist', 'bundle', 'pdfkiln.cjs') : join(root, 'dist', 'src', 'bin', 'pdfkiln.js');
  const serve = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((ok) => {
    const p = spawn(...command(process.env.PDFKILN_TEST_PDFKILN, pdfkiln, ['serve', ...args]), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => ok({ code, stdout, stderr }));
  });

  test('pdfkiln serve exits 1, and says why', async () => {
    for (const args of [[], ['--help'], ['--socket', join(dir, 'x.sock')]]) {
      const r = await serve(args);
      assert.deepEqual(r, { code: 1, stdout: '', stderr: 'pdfkiln serve was removed in 1.2.0: each conversion starts its own Chromium\n' });
    }
  });

  test('the commands look for no server: PDFKILN_SERVER, the socket of 1.1', async () => {
    // Where 1.1 looked: PDFKILN_SERVER, else run/chromium.sock in the cache
    // folder; on Windows, a pipe. The cache folder is the one the commands
    // already use when the environment names one: the npm package keeps
    // Chromium there, and in another folder would download it again, where
    // no AppArmor profile lets its sandbox start on Ubuntu 24.04.
    const cache = process.env.PDFKILN_CACHE_DIR ?? join(dir, 'cache');
    mkdirSync(join(cache, 'run'), { recursive: true });
    const paths = process.platform === 'win32' ? [`\\\\.\\pipe\\pdfkiln-test-${process.pid}`] : [join(dir, 'server.sock'), join(cache, 'run', 'chromium.sock')];
    let connections = 0;
    const servers = await Promise.all(paths.map((p) => new Promise<ReturnType<typeof createTcpServer>>((ok, fail) => {
      const s = createTcpServer((c) => {
        connections++;
        c.destroy();
      });
      s.once('error', fail).listen(p, () => ok(s));
    })));
    try {
      const r = await run(['-q', `${base}/ok`, join(dir, 'no-server.pdf')], { env: { PDFKILN_SERVER: paths[0], PDFKILN_CACHE_DIR: cache } });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(connections, 0);
    } finally {
      for (const s of servers) s.close();
    }
  });
});
