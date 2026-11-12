// PDF/A, on real Chromium output (test/fixtures/simple.pdf).
//
// These tests prove what can be proved without a validator: the level asked
// for is the level written, the output intent and the XMP are there, the file
// still opens, and a document that cannot conform is refused rather than
// labelled. Conformance itself is veraPDF's word.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, StandardFonts } from '@cantoo/pdf-lib';
import { archive } from '../src/pdf/archive.js';
import { ArchiveError, DEFAULT_LEVEL, LEVELS, applyPdfa, fontsNotEmbedded, readLevel, type Level } from '../src/pdf/pdfa.js';

const root = resolve(import.meta.dirname, '..', '..');
const simple = readFileSync(join(root, 'test', 'fixtures', 'simple.pdf'));

// The error a call refuses with.
function refusal(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail('the call returned instead of refusing');
}

// The XMP packet of a saved file, as text.
async function xmp(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const stream = doc.catalog.lookupMaybe(PDFName.of('Metadata'), PDFStream);
  assert.ok(stream instanceof PDFRawStream, 'the saved file has no XMP metadata');
  return Buffer.from(stream.contents).toString('utf8');
}

const toPdfa = (bytes: Uint8Array, level: Level) => archive(bytes, { level });

test('the four levels PDFKiln writes are read, in any case, the default when empty', () => {
  assert.deepEqual(Object.keys(LEVELS), ['2b', '2u', '3b', '3u']);
  assert.equal(readLevel(''), DEFAULT_LEVEL);
  assert.equal(DEFAULT_LEVEL, '3b');
  for (const level of Object.keys(LEVELS)) {
    assert.equal(readLevel(level), level);
    assert.equal(readLevel(level.toUpperCase()), level);
    assert.equal(readLevel(` ${level} `), level);
  }
});

test('PDF/A-1b is refused with its reason: transparency, which PDFKiln does not flatten', () => {
  const err = refusal(() => readLevel('1b'));
  assert.ok(err instanceof ArchiveError);
  assert.match(err.message, /forbids transparency/);
  assert.match(err.message, /does not flatten it into images/);
  assert.match(err.message, /2b, 2u, 3b, 3u/);
});

test('level A is refused for what it needs, a tagged document', () => {
  for (const level of ['1a', '2a', '3a']) assert.match(refusal(() => readLevel(level)).message, /fully tagged document/, level);
});

test('a level that does not exist at all says so', () => {
  for (const bad of ['4b', '1', 'pdfa', '3c']) {
    const err = refusal(() => readLevel(bad));
    assert.ok(err instanceof ArchiveError, bad);
    assert.match(err.message, /no such level/);
  }
});

test('Chromium’s output embeds every font it names', async () => {
  assert.deepEqual(fontsNotEmbedded(await PDFDocument.load(simple, { updateMetadata: false })), []);
});

test('each level is written into the XMP, and the file still opens', async () => {
  const before = await PDFDocument.load(simple, { updateMetadata: false });
  for (const level of Object.keys(LEVELS) as Level[]) {
    const bytes = await toPdfa(simple, level);
    const packet = await xmp(bytes);
    assert.match(packet, new RegExp(`<pdfaid:part>${level[0]}</pdfaid:part>`), `${level}: part`);
    assert.match(packet, new RegExp(`<pdfaid:conformance>${level[1]!.toUpperCase()}<`), `${level}: conformance`);
    const after = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(after.getPageCount(), before.getPageCount(), `${level}: page count changed`);
    assert.ok(after.catalog.get(PDFName.of('OutputIntents')), `${level}: no output intent`);
  }
});

test('a font that is not embedded is refused, not labelled PDF/A', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText('One of the fourteen: the bytes are the reader’s.', { font, size: 12, x: 50, y: 700 });
  const bytes = await doc.save();
  assert.deepEqual(fontsNotEmbedded(await PDFDocument.load(bytes, { updateMetadata: false })), ['Helvetica']);
  const err = refusal(() => applyPdfa(doc, '3b'));
  assert.ok(err instanceof ArchiveError);
  assert.match(err.message, /Helvetica/);
  assert.match(err.message, /not embedded/);
  // Through the command's path, the option is named.
  await assert.rejects(toPdfa(bytes, '3b'), (e) => e instanceof ArchiveError && /^--pdfa: a font is not embedded/.test(e.message));
});

test('a u level is refused when the text cannot be extracted, a b level is not', async () => {
  // pdf-lib writes the level without checking the maps: stripping them is the
  // only way to see the guard work.
  const strip = async (): Promise<PDFDocument> => {
    const doc = await PDFDocument.load(simple, { updateMetadata: false });
    for (const page of doc.getPages()) {
      const table = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
      if (!table) continue;
      for (const [, value] of table.entries()) doc.context.lookupMaybe(value, PDFDict)?.delete(PDFName.of('ToUnicode'));
    }
    return doc;
  };
  const stripped = await strip();
  const err = refusal(() => applyPdfa(stripped, '3u'));
  assert.ok(err instanceof ArchiveError);
  assert.match(err.message, /no Unicode map/);
  assert.match(err.message, /Level 3b does not/);
  // The same file at 3b goes through: that level asks nothing of the text.
  applyPdfa(await strip(), '3b');
});

test('converting a file that is already PDF/A leaves it one', async () => {
  const twice = await toPdfa(await toPdfa(simple, '3b'), '3b');
  const packet = await xmp(twice);
  assert.match(packet, /<pdfaid:part>3<\/pdfaid:part>/);
  assert.equal((packet.match(/<pdfaid:part>/g) ?? []).length, 1, 'the XMP declares the part twice');
});
