// --cookie-jar as wkhtmltopdf 0.12.6 reads it, sends its cookies and writes
// it back (Qt 4.8's QNetworkCookie and QNetworkCookieJar), measured on
// 18/11/2026 against the official wkhtmltox 0.12.6.1-3 package.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { QtJar, readJar, type JarCookie } from '../src/wk/cookiejar.js';

test('a jar as Odoo writes it: one line, its domain the host of the report URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfkiln-jar-'));
  try {
    const path = join(dir, 'jar.txt');
    for (const host of ['127.0.0.1', 'odoo.example.com']) {
      writeFileSync(path, `session_id=abc; HttpOnly; domain=${host}; path=/;`);
      assert.deepEqual(readJar(path), [{ name: 'session_id', value: 'abc', httpOnly: true, domain: host, path: '/' }]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A cookie as Chromium gives it, in an order of its own.
const held = (name: string, value: string, domain: string, path = '/', secure = false) => ({ name, value, domain, path, secure });

test('the Cookie header of a request: the longest paths first, then in the jar\'s order; a secure cookie over https only', () => {
  const read: JarCookie[] = [
    { name: 'host', value: '1', domain: 'odoo.test', path: '/' },
    { name: 'dot', value: '1', domain: '.odoo.test', path: '/' },
    { name: 'sub', value: '1', domain: 'odoo.test', path: '/sub/' },
    { name: 'sec', value: '1', domain: 'odoo.test', path: '/', secure: true },
  ];
  const jar = new QtJar();
  jar.loaded(read, read);
  const matched = [held('sec', '1', 'odoo.test', '/', true), held('dot', '1', '.odoo.test'), held('sub', '1', 'odoo.test', '/sub/'), held('host', '1', 'odoo.test')];
  assert.equal(jar.line(matched, 'http://odoo.test/sub/a.css'), 'sub=1; host=1; dot=1');
  assert.equal(jar.line(matched, 'https://odoo.test/sub/a.css'), 'sub=1; host=1; dot=1; sec=1');
  // A cookie a server set comes after those of the file.
  assert.equal(jar.line([held('srv', '1', 'odoo.test'), held('dot', '1', '.odoo.test'), held('host', '1', 'odoo.test')], 'http://odoo.test/a.css'), 'host=1; dot=1; srv=1');
  assert.equal(jar.line([held('sec', '1', 'localhost', '/', true)], 'http://localhost/'), '');
  assert.equal(jar.line([], 'http://odoo.test/'), '');
  // --cookie, given, comes last, whatever the URL.
  assert.equal(jar.line([held('srv', '1', 'odoo.test')], 'http://odoo.test/a.css', [['g', '1']]), 'srv=1; g=1');
  assert.equal(jar.line([], 'http://other.test/', [['g', '1']]), 'g=1');
});

test('the jar written back: in its order, unchanged cookies as read, the file\'s cookies Chromium did not take kept, a server\'s last', () => {
  const far = Date.UTC(2030, 0, 1) / 1000;
  const read: JarCookie[] = [
    { name: 'ip', value: '1', domain: '127.0.0.1', path: '/', httpOnly: true },
    { name: 'nodomain', value: '1', path: '/' },
    { name: 'far', value: '1', domain: '127.0.0.1', path: '/', expires: far },
    { name: 'relative', value: '1', domain: '127.0.0.1', path: 'relative' },
    { name: 'changed', value: 'old', domain: '127.0.0.1', path: '/' },
    { name: 'deleted', value: '1', domain: '127.0.0.1', path: '/' },
    { name: 'expired', value: 'old', domain: '127.0.0.1', path: '/', expires: 1 },
  ];
  const jar = new QtJar();
  jar.loaded(read, [read[0]!, read[2]!, read[4]!, read[5]!]);
  // At the end, Chromium holds a cookie a server set, two it replaced, and
  // the file's with its expiry capped at 400 days.
  const out = jar.toWrite([
    { name: 'srv', value: '1', domain: '127.0.0.1', path: '/' },
    { name: 'changed', value: 'new', domain: '127.0.0.1', path: '/' },
    { name: 'expired', value: 'new', domain: '127.0.0.1', path: '/' },
    { name: 'far', value: '1', domain: '127.0.0.1', path: '/', expires: far - 1e7 },
    { name: 'ip', value: '1', domain: '127.0.0.1', path: '/', httpOnly: true, secure: false },
  ]);
  assert.deepEqual(out.map((c) => `${c.name}=${c.value}`), ['ip=1', 'nodomain=1', 'far=1', 'relative=1', 'srv=1', 'changed=new', 'expired=new']);
  assert.equal(out[2]!.expires, far);
});
