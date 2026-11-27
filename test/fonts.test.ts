import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { qtFamilies, sfntFamilies } from '../src/engine/fonts.js';

const all = (f: string) => ({ standard: f, serif: f, sansSerif: f, fixed: f, cursive: f, fantasy: f, math: f });

// What wkhtmltopdf 0.12.6 takes on Debian 13 under several sets of fonts
// (measured on 21/11/2026).
test("the generic families get wkhtmltopdf's fonts, as they are installed", () => {
  // Microsoft's core fonts, as ttf-mscorefonts-installer installs them: no
  // need of the last resort.
  assert.deepEqual(qtFamilies(['Arial', 'Comic Sans MS', 'Courier New', 'DejaVu Sans', 'Impact', 'Times New Roman']), {
    standard: 'Times New Roman', serif: 'Times New Roman', sansSerif: 'Arial', fixed: 'Courier New',
    cursive: 'Comic Sans MS', fantasy: 'Impact', math: 'Times New Roman',
  });
  // A generic family missing falls to the standard one.
  assert.deepEqual(qtFamilies(['Arial', 'Courier New', 'DejaVu Sans', 'Times New Roman'], 'Arial'), {
    standard: 'Times New Roman', serif: 'Times New Roman', sansSerif: 'Arial', fixed: 'Courier New',
    cursive: 'Times New Roman', fantasy: 'Times New Roman', math: 'Times New Roman',
  });
  // And the standard one to the last resort, fontconfig's font for Helvetica,
  // without which there is none.
  assert.deepEqual(qtFamilies(['Arial', 'DejaVu Sans'], 'Arial'), all('Arial'));
  assert.equal(qtFamilies(['Arial', 'DejaVu Sans']), undefined);
  assert.equal(qtFamilies(['Arial', 'DejaVu Sans'], ''), undefined);
  // Without them, every family gets the last resort: fontconfig's aliases
  // (Liberation Serif for Times New Roman, Nimbus Roman for Times) are not
  // installed families.
  assert.deepEqual(qtFamilies(['DejaVu Sans', 'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Nimbus Mono PS', 'Nimbus Roman', 'Nimbus Sans'], 'Nimbus Sans'), all('Nimbus Sans'));
  assert.deepEqual(qtFamilies([], 'DejaVu Sans'), all('DejaVu Sans'));
  // Times, Helvetica and Courier come before the families WebKit pairs them
  // with, in any case.
  assert.deepEqual(qtFamilies(['times', 'Times New Roman', 'Helvetica', 'Arial', 'Courier'], 'X'), {
    standard: 'times', serif: 'times', sansSerif: 'Helvetica', fixed: 'Courier', cursive: 'times', fantasy: 'times', math: 'times',
  });
});

test('the family names written in a font file, TrueType and WOFF', () => {
  const lato = join(resolve(import.meta.dirname, '..', '..'), 'corpus', '_shared', 'odoo17', 'www', 'web', 'static', 'fonts', 'lato');
  assert.deepEqual(sfntFamilies(readFileSync(join(lato, 'Lato-RegIta-webfont.ttf'))), ['Lato']);
  assert.deepEqual(sfntFamilies(readFileSync(join(lato, 'Lato-Bla-webfont.woff'))), ['Lato']);
  assert.deepEqual(sfntFamilies(Buffer.from('not a font')), []);
});
