// The option table against the list extracted from wkhtmltopdf's source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { IMAGE_OPTIONS, parseImageArguments } from '../src/wk/image.js';
import { KILN_OPTIONS, OPTIONS } from '../src/wk/options.js';
import { parseArguments } from '../src/wk/parse.js';
import { optionsMarkdown } from '../scripts/options-doc.js';

const root = resolve(import.meta.dirname, '..', '..');
const ref = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'wkhtmltopdf-0.12.6-options.json'), 'utf8')) as {
  options: { name: string; short: string | null; mode: string; argn: number }[];
};

test('the 122 options of wkhtmltopdf 0.12.6, in order', () => {
  assert.equal(ref.options.length, 122);
  assert.deepEqual(
    OPTIONS.map((o) => ({ name: o.name, short: o.short ?? null, mode: o.mode, argn: o.args.length })),
    ref.options,
  );
});

test('PDF/A and Factur-X are for the native command line only: the compatible one does not take them', () => {
  for (const name of ['pdfa', 'factur-x', 'kiln-pdfa', 'kiln-factur-x']) {
    assert.throws(() => parseArguments(['wkhtmltopdf', `--${name}`, 'x', 'in.html', 'out.pdf']), /Unknown long argument/, name);
  }
});

test('our options never collide with wkhtmltopdf names', () => {
  for (const o of KILN_OPTIONS) {
    assert.ok(o.name.startsWith('kiln-'));
    assert.equal(o.short, undefined);
  }
});

// Every option is accepted where wkhtmltopdf accepts it: no "unknown
// option", no "incorrect location" (except actions, which exit).
test('each option is accepted with valid arguments', () => {
  const sample: Record<string, string> = {
    'log-level': 'warn', orientation: 'Landscape', 'page-size': 'Letter', 'proxy': 'http://u:p@proxy:3128',
    'load-error-handling': 'ignore', 'load-media-error-handling': 'skip', 'viewport-size': '1280x1024',
  };
  for (const o of [...OPTIONS, ...KILN_OPTIONS]) {
    if (o.action) continue;
    const values = o.args.map((a) => sample[o.name] ?? (/^(number|dpi|integer|level|int|size|offset|msec)$/.test(a) ? '3' : /unitreal/.test(a) ? '12mm' : /^(real|float|seconds)$/.test(a) ? '1.5' : 'x'));
    const argv = o.mode === 'global'
      ? ['wkhtmltopdf', `--${o.name}`, ...values, 'in.html', 'out.pdf']
      : o.mode === 'page'
        ? ['wkhtmltopdf', 'in.html', `--${o.name}`, ...values, 'out.pdf']
        : ['wkhtmltopdf', 'toc', `--${o.name}`, ...values, 'in.html', 'out.pdf'];
    assert.doesNotThrow(() => parseArguments(argv), `--${o.name}`);
  }
});

test('docs/options.md is current (node dist/scripts/options-doc.js)', () => {
  assert.equal(readFileSync(join(root, 'docs', 'options.md'), 'utf8').replace(/\r\n/g, '\n'), optionsMarkdown());
});

test('the 63 options of wkhtmltoimage 0.12.6', () => {
  const image = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'wkhtmltoimage-0.12.6-options.json'), 'utf8')) as {
    options: { name: string; short: string | null; argn: number }[];
  };
  assert.equal(image.options.length, 63);
  const ours = IMAGE_OPTIONS.map((o) => ({ name: o.name, short: o.short ?? null, argn: o.args.length }));
  assert.deepEqual(ours.sort((a, b) => a.name.localeCompare(b.name)), [...image.options].sort((a, b) => a.name.localeCompare(b.name)));
  for (const o of IMAGE_OPTIONS) {
    if (o.action) continue;
    const values = o.args.map((a) => (o.name === 'log-level' ? 'warn' : o.name === 'proxy' ? 'none' : /handler/.test(a) ? 'ignore' : /^(int|msec)$/.test(a) ? '3' : a === 'float' ? '1.5' : 'x'));
    assert.doesNotThrow(() => parseImageArguments(['wkhtmltoimage', `--${o.name}`, ...values, 'in.html', 'out.png']), `--${o.name}`);
  }
});
