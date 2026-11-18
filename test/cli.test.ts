// The compatible command end to end, with Chromium: what the libraries
// rely on (exit codes, stderr, standard input and output), what the
// specification promises (objects, numbering, headers), and the security
// rules. Needs the pinned Chromium (npm run fetch:chromium) and an
// unprivileged user: the sandbox stays on. Text checks use PyMuPDF
// (bench/requirements.txt) and are skipped without it.
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString } from '@cantoo/pdf-lib';
import { launch } from '../src/engine/browser.js';
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
    if (path === '/img') imgHeader = String(req.headers['x-test'] ?? 'none');
    if (path === '/img') imgCookie = String(req.headers.cookie ?? 'none');
    if (path === '/third-party') return html(`<img src="${other}/img">`);
    if (path === '/img') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text y="10">${req.headers['x-test'] ?? 'none'}</text></svg>`);
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
  rmSync(dir, { recursive: true, force: true });
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
});

describe('security', () => {
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
  const native = (args: string[], stdin = ''): Promise<Run> => new Promise((ok) => {
    const t0 = performance.now();
    const child = spawn(...command(process.env.PDFKILN_TEST_PDFKILN, pdfkiln, args), { cwd: dir });
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

  test('pdfkiln wkhtmltopdf switches to the compatible mode', async () => {
    const r = await native(['wkhtmltopdf', '--version']);
    assert.match(r.stdout.toString(), /^wkhtmltopdf 0\.12\.6/);
  });

  test('--help and --version: the name PDFKiln, the command pdfkiln', async () => {
    let r = await native(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.toString(), /^PDFKiln: HTML and Markdown to PDF with Chromium\n\nUsage:\n {2}pdfkiln \[options\] <input>\.\.\. <output>\n/);
    assert.match(r.stdout.toString(), /\n {2}wkhtmltopdf {17}The command line of wkhtmltopdf 0\.12\.6\n/);
    assert.match(r.stdout.toString(), /\nDocument properties \(default: from the front matter of Markdown\):\n {2}--title <text> {14}Title \(default: the page's <title>\)\n/);
    assert.match(r.stdout.toString(), /\n {2}--from markdown {13}Read every input as Markdown, whatever its name\n/);
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
