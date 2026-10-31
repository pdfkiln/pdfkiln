// The compatible command end to end, with Chromium: what the libraries
// rely on (exit codes, stderr, standard input and output), what the
// specification promises (objects, numbering, headers), and the security
// rules. Needs the pinned Chromium (npm run fetch:chromium) and an
// unprivileged user: the sandbox stays on. Text checks use PyMuPDF
// (bench/requirements.txt) and are skipped without it.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';

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

function run(args: string[], opts: { stdin?: string | Buffer; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  return new Promise((ok) => {
    const t0 = performance.now();
    const env = { ...process.env, ...opts.env };
    delete env.NODE_EXTRA_CA_CERTS;
    const child = spawn(...command(process.env.PDFKILN_TEST_WKHTMLTOPDF, cli, args), { cwd: opts.cwd ?? dir, env });
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

let server: Server;
let base = '';
// The same server under another origin.
let other = '';
let hangs: (() => void)[] = [];
// X-Test as the last /img request carried it.
let imgHeader = '';
// And its Cookie.
let imgCookie = '';
before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const html = (body: string, status = 200) => res.writeHead(status, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);
    if (path === '/ok') return html('<h1>Hello</h1>');
    if (path === '/set-cookie') return res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'secret=1; Path=/' }).end('<p>set</p>');
    if (path === '/show-cookie') return html(`<p>Cookie: ${req.headers.cookie ?? 'none'}</p>`);
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
    // A page whose resources the last line answers in 404, and a page that
    // asks for a password.
    if (path === '/resources') {
      return html(`<style>@font-face { font-family: F; src: url(/font) } p { font-family: F }</style><p>resources</p>
        <img src="/image"><img src="/image.png"><link rel="stylesheet" href="/style.css"><iframe src="/frame"></iframe>
        <script>const x = new XMLHttpRequest(); x.open('GET', '/data'); x.send();</script>`);
    }
    if (path === '/auth') return res.writeHead(401, { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="pdfkiln"' }).end('<p>auth</p>');
    if (path === '/headers') return html(`<p>X-Test=${req.headers['x-test'] ?? 'none'}</p><img src="/img">`);
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
after(() => {
  for (const h of hangs) h();
  hangs = [];
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

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
    // No version: they would tell who receives the PDF which flaws the server has.
    assert.deepEqual([doc.getCreator(), doc.getProducer()], ['pdfkiln', 'pdfkiln.org']);
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

  test('an unknown host: exit 1, no PDF', async () => {
    const r = await run(['-q', 'http://pdfkiln-nonexistent.invalid/', join(dir, 'none.pdf')]);
    assert.equal(r.code, 1);
    assert.equal(lastLine(r.stderr), 'Exit with code 1 due to network error: HostNotFoundError');
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
    const d = join(dir, 'tls');
    mkdirSync(d, { recursive: true });
    const ossl = (...a: string[]) => execFileSync('openssl', a, { cwd: d, stdio: 'ignore' });
    try {
      ossl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Test CA');
      ossl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost');
      ossl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '2');
      ossl('req', '-newkey', 'rsa:2048', '-passout', 'pass:secret', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=Kiln client');
      ossl('x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.crt', '-days', '2');
    } catch {
      return t.skip('openssl missing');
    }
    const tls = createHttpsServer({
      key: readFileSync(join(d, 'server.key')),
      cert: readFileSync(join(d, 'server.crt')),
      ca: readFileSync(join(d, 'ca.crt')),
      requestCert: true,
      rejectUnauthorized: true,
    }, (req, res) => {
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
      const cert = ['--ssl-crt-path', join(d, 'client.crt'), '--ssl-key-path', join(d, 'client.key'), '--ssl-key-password', 'secret'];
      const r = await run(['-q', '--cookie', 'k', 'v', url, ...cert, out]);
      assert.equal(r.code, 0, r.stderr);
      if (hasPyMuPDF) assert.match(pagesText(out)[0]!, /GET by Kiln client with k=v and styled/);
      // Without it, the server refuses the page.
      assert.equal((await run(['-q', url, out])).code, 1);
    } finally {
      tls.close();
    }
    if (!hasPyMuPDF) t.skip('PyMuPDF missing');
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
    const r = await run(['-q', '--javascript-delay', '5000', quiet, join(dir, 'quiet.pdf')]);
    assert.equal(r.code, 0);
    assert.ok(r.ms < 4000, `a quiet page waited ${Math.round(r.ms)} ms`);
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
    try {
      symlinkSync(join(dir, 'secret', 'key.png'), join(allowed, 'link.png'));
    } catch {
      // Windows without the right to create links.
    }
    const page = file('jail/page.html', '<img src="../secret/key.png"><img src="link.png"><img src="/etc/passwd">');
    const r = await run(['--log-level', 'warn', '--allow', allowed, page, join(dir, 'j.pdf')]);
    const blocked = r.stderr.split('\n').filter((l) => l.startsWith('Warning: Blocked access to file'));
    assert.ok(blocked.length >= 2, r.stderr);
    assert.equal(r.code, 1);
  });

  test('--kiln-block-private-network refuses loopback, by address and by name', async () => {
    for (const url of [`${base}/ok`, base.replace('127.0.0.1', 'localhost') + '/ok']) {
      const r = await run(['--log-level', 'warn', '--kiln-block-private-network', url, join(dir, 'p.pdf')]);
      assert.equal(r.code, 1, url);
      // The relay's refusal is a 403, worded as wkhtmltopdf words one.
      assert.equal(r.stderr, `Error: Failed to load ${url}, with network status code 202 and http status code 403 - Error downloading ${url} - server replied: Forbidden\nExit with code 1 due to network error: ContentOperationNotPermittedError\n`);
    }
    const r = await run(['-q', `${base}/ok`, join(dir, 'p.pdf')]);
    assert.equal(r.code, 0);
  });

  test('--kiln-timeout stops the conversion and Chromium', async () => {
    const r = await run(['-q', '--kiln-timeout', '2', `${base}/hang`, join(dir, 't.pdf')]);
    for (const h of hangs) h();
    hangs = [];
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--kiln-timeout/);
    assert.ok(r.ms < 15000, `${r.ms} ms`);
    if (process.platform !== 'win32') {
      // Killed processes take a moment to disappear from ps.
      const left = () => execFileSync('ps', ['-eo', 'stat,args'], { encoding: 'utf8' }).split('\n')
        .some((l) => !l.startsWith('Z') && l.includes('chrome-headless-shell') && l.includes(tmpdir()) && l.includes('pdfkiln-') && !l.includes('pdfkiln-test'));
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
    assert.deepEqual([doc.getCreator(), doc.getProducer()], ['pdfkiln', 'pdfkiln.org']);
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
    const r = await native(['--javascript-delay', '5000', quiet, join(dir, 'native-quiet.pdf')]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 4000, `a quiet page waited ${Math.round(r.ms)} ms`);
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
    // An address is private, a name resolves to one.
    for (const [url, host] of [[`${base}/ok`, '127.0.0.1 is'], [`${other}/ok`, 'localhost resolves to']] as const) {
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

  test('a certificate that Chromium refuses is named', async (t) => {
    const d = join(dir, 'native-tls');
    mkdirSync(d, { recursive: true });
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '2', '-subj', '/CN=localhost'], { cwd: d, stdio: 'ignore' });
    } catch {
      return t.skip('openssl missing');
    }
    const tls = createHttpsServer({ key: readFileSync(join(d, 'k.pem')), cert: readFileSync(join(d, 'c.pem')) }, (_, res) => res.end('<p>tls</p>'));
    await new Promise<void>((ok) => tls.listen(0, '127.0.0.1', ok));
    try {
      const url = `https://127.0.0.1:${(tls.address() as AddressInfo).port}/`;
      const r = await native(['--allow-private-network', url, join(dir, 'native-tls.pdf')]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`^pdfkiln: error: could not load ${url}: invalid certificate \\(net::ERR_CERT_[A-Z_]+\\)\\n$`));
    } finally {
      tls.close();
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
});

describe('pdfkiln serve', () => {
  const pdfkiln = bundled ? join(root, 'dist', 'bundle', 'pdfkiln.cjs') : join(root, 'dist', 'src', 'bin', 'pdfkiln.js');

  test('conversions use the Chromium kept open, each in a context of its own', async (t) => {
    const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pdfkiln-test-${process.pid}` : join(dir, 'serve', 'chromium.sock');
    // Killed on Windows, serve cannot remove its folder: it goes in the suite's.
    const tmp = mkdtempSync(join(dir, 'serve-tmp-'));
    const server = spawn(...command(process.env.PDFKILN_TEST_PDFKILN, pdfkiln, ['serve', '--socket', socket]), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
    });
    let log = '';
    await new Promise<void>((ok, fail) => {
      server.stderr.on('data', (d) => {
        log += d;
        if (/serving on/.test(log)) ok();
      });
      server.once('exit', () => fail(new Error(`pdfkiln serve exited: ${log}`)));
    });
    try {
      const env = { PDFKILN_SERVER: socket, PDFKILN_TIMINGS: '1' };
      const [a, b] = await Promise.all([
        run(['-q', `${base}/set-cookie`, join(dir, 'serve-a.pdf')], { env }),
        run(['-q', `${base}/ok`, join(dir, 'serve-b.pdf')], { env }),
      ]);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(b.code, 0, b.stderr);
      assert.match(a.stderr, /"served":1/);
      const c = await run(['-q', `${base}/show-cookie`, join(dir, 'serve-c.pdf')], { env });
      assert.equal(c.code, 0, c.stderr);
      if (hasPyMuPDF) assert.match(pagesText(join(dir, 'serve-c.pdf'))[0]!, /Cookie: none/);
      // No server there: the command starts its own Chromium.
      const d = await run(['-q', `${base}/ok`, join(dir, 'serve-d.pdf')], { env: { PDFKILN_SERVER: join(dir, 'nowhere.sock'), PDFKILN_TIMINGS: '1' } });
      assert.equal(d.code, 0, d.stderr);
      assert.doesNotMatch(d.stderr, /"served"/);
    } finally {
      const exited = new Promise((ok) => server.once('exit', ok));
      // Windows has no SIGTERM: the tree is killed.
      if (process.platform === 'win32') (await import('../src/engine/browser.js')).killTree(server.pid);
      else server.kill('SIGTERM');
      await exited;
      // The killed Chromium holds its files a few seconds more on Windows.
      await (await import('../src/engine/browser.js')).removeWhenFree(tmp, 30000);
    }
    if (process.platform !== 'win32') assert.ok(!existsSync(socket), 'socket removed');
    if (!hasPyMuPDF) t.skip('PyMuPDF missing');
  });
});
