import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { frames, Mux, sameChromium, socketPath } from '../src/engine/server.js';
import { chromiumVersion } from '../src/version.js';

const collect = () => {
  const got: string[] = [];
  return { got, push: frames((m) => got.push(m)) };
};

test('several messages in one chunk, and one over several', () => {
  const { got, push } = collect();
  push(Buffer.from('{"id":1}\0{"id":2}\0{"id"'));
  push(Buffer.from(':3,"result"'));
  push(Buffer.from(':{}}\0'));
  assert.deepEqual(got, ['{"id":1}', '{"id":2}', '{"id":3,"result":{}}']);
});

test('a character split between two chunks', () => {
  const { got, push } = collect();
  const message = Buffer.from('{"title":"Facture é"}\0');
  const cut = message.indexOf(Buffer.from('é')) + 1;
  push(message.subarray(0, cut));
  push(message.subarray(cut));
  assert.deepEqual(got, ['{"title":"Facture é"}']);
});

test('a server is used only if it runs the Chromium the command would start', () => {
  assert.equal(sameChromium(`HeadlessChrome/${chromiumVersion}`, {}), true);
  assert.equal(sameChromium('HeadlessChrome/1.0.0.0', {}), false);
  // With PDFKILN_CHROMIUM, the command does not know its own version.
  assert.equal(sameChromium('HeadlessChrome/1.0.0.0', { PDFKILN_CHROMIUM: '/opt/chrome-headless-shell' }), true);
});

test('no server on Windows, even with PDFKILN_SERVER', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const before = process.env.PDFKILN_SERVER;
  process.env.PDFKILN_SERVER = '\\\\.\\pipe\\pdfkiln-somebody';
  try {
    assert.equal(socketPath(), null);
  } finally {
    if (before === undefined) delete process.env.PDFKILN_SERVER;
    else process.env.PDFKILN_SERVER = before;
  }
});

test('a context made after its client left is closed', () => {
  const toChromium: string[] = [];
  const mux = new Mux((m) => toChromium.push(m));
  const client = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  mux.connect(client as unknown as Socket);
  client.emit('data', Buffer.from('{"id":7,"method":"Target.createBrowserContext","params":{}}\0'));
  const asked = JSON.parse(toChromium[0]!) as { id: number; method: string };
  assert.equal(asked.method, 'Target.createBrowserContext');
  // The conversion stops before Chromium answers.
  client.emit('close');
  mux.fromChromium(JSON.stringify({ id: asked.id, result: { browserContextId: 'CTX' } }));
  const disposed = JSON.parse(toChromium[1]!) as { method: string; params: { browserContextId: string } };
  assert.equal(disposed.method, 'Target.disposeBrowserContext');
  assert.equal(disposed.params.browserContextId, 'CTX');
});
