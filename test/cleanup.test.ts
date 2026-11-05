// The helper a conversion leaves behind on Windows (src/engine/cleanup.ts):
// it removes the folder of a conversion, and nothing else.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { isConversionFolder } from '../src/engine/cleanup.js';

test('only pdfkiln-* in the temporary folder is a conversion\'s folder', () => {
  const tmp = tmpdir();
  assert.ok(isConversionFolder(join(tmp, 'pdfkiln-aB3dE9'), tmp));
  for (const other of [
    join(tmp, 'pdfkiln-aB3dE9', 'chromium'),
    join(tmp, 'pdfkiln-aB3dE9', '..', '..', 'pdfkiln-aB3dE9'),
    join(tmp, 'other-aB3dE9'),
    join(tmp, 'pdfkiln-aB3dE9x'),
    join(tmp, 'pdfkiln-ab'),
    join(tmp, 'pdfkiln-test-aB3dE9'),
    tmp,
  ]) assert.ok(!isConversionFolder(other, tmp), other);
  assert.ok(isConversionFolder(join(tmp.toUpperCase(), 'pdfkiln-aB3dE9'), tmp, 'win32'));
  assert.ok(!isConversionFolder(join(tmp.toUpperCase(), 'pdfkiln-aB3dE9'), tmp, 'linux') || tmp === tmp.toUpperCase());
});

test('run from another program, a conversion removes its folder itself: no helper', { skip: process.platform !== 'win32' && 'the helper is for Windows' }, () => {
  // As a bench would: the engine imported by a script, which would be the
  // helper run again; started so, it stops at once rather than loop.
  const browser = pathToFileURL(resolve(import.meta.dirname, '..', 'src', 'engine', 'browser.js')).href;
  const script = join(mkdtempSync(join(tmpdir(), 'pdfkiln-test-')), 'embed.mjs');
  writeFileSync(script, `if (process.env.PDFKILN_CLEANUP) process.exit(3);
const { launch } = await import(${JSON.stringify(browser)});
const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const work = mkdtempSync(join(tmpdir(), 'pdfkiln-'));
const s = await launch({ dir: work });
await s.close();
process.stdout.write(existsSync(join(work, 'chromium')) ? 'left' : 'removed');
rmSync(work, { recursive: true, force: true });
`);
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'removed');
  rmSync(join(script, '..'), { recursive: true, force: true });
});

test('the program in its cleanup mode removes a conversion\'s folder, and refuses another', () => {
  const bin = resolve(import.meta.dirname, '..', 'src', 'bin', 'pdfkiln.js');
  const work = mkdtempSync(join(tmpdir(), 'pdfkiln-'));
  mkdirSync(join(work, 'chromium'));
  let r = spawnSync(process.execPath, [bin], { env: { ...process.env, PDFKILN_CLEANUP: work }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(work));
  const kept = mkdtempSync(join(tmpdir(), 'pdfkiln-test-'));
  try {
    r = spawnSync(process.execPath, [bin], { env: { ...process.env, PDFKILN_CLEANUP: kept }, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 1);
    assert.ok(existsSync(kept));
  } finally {
    rmSync(kept, { recursive: true, force: true });
  }
});
