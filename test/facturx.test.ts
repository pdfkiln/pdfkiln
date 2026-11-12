// Factur-X and ZUGFeRD: reading the invoice we are handed, checking the
// options before the render, and attaching the invoice as its profile
// requires.
//
// What is checked here is what PDFKiln promises to check: the profile, the
// three fields every profile requires, and that the file is a CII invoice at
// all. The EN 16931 business rules are not checked, by decision and not by
// omission (src/pdf/facturx.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString } from '@cantoo/pdf-lib';
import { archive, archiveRequest, COMPATIBLE, NATIVE } from '../src/pdf/archive.js';
import { embedding, readInvoice } from '../src/pdf/facturx.js';
import { ArchiveError } from '../src/pdf/pdfa.js';

const root = resolve(import.meta.dirname, '..', '..');
const fixtures = join(root, 'test', 'fixtures');
const invoicePath = join(fixtures, 'invoice-minimum.xml');
const invoiceXml = readFileSync(invoicePath);
const simple = readFileSync(join(fixtures, 'simple.pdf'));
const dir = mkdtempSync(join(tmpdir(), 'pdfkiln-facturx-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// The error a call refuses with.
function refusal(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail('the call returned instead of refusing');
}

// The fixture with another profile URN.
const withUrn = (urn: string): Uint8Array =>
  new TextEncoder().encode(new TextDecoder().decode(invoiceXml).replace('urn:factur-x.eu:1p0:minimum', urn));

// The fixture with another profile, as a file, for the options.
function invoiceFile(name: string, urn: string): string {
  const file = join(dir, name);
  writeFileSync(file, withUrn(urn));
  return file;
}

// The files a PDF associates with its document (/AF): name and relationship.
function associated(doc: PDFDocument): { name: string; relationship: string }[] {
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  const out: { name: string; relationship: string }[] = [];
  for (let i = 0; af && i < af.size(); i++) {
    const spec = doc.context.lookup(af.get(i), PDFDict);
    const name = spec.lookup(PDFName.of('UF')) ?? spec.lookup(PDFName.of('F'));
    out.push({
      name: name instanceof PDFString || name instanceof PDFHexString ? name.decodeText() : String(name),
      relationship: String(spec.lookup(PDFName.of('AFRelationship'))),
    });
  }
  return out;
}

async function xmpOf(doc: PDFDocument): Promise<string> {
  const stream = doc.catalog.lookupMaybe(PDFName.of('Metadata'), PDFStream);
  assert.ok(stream instanceof PDFRawStream, 'no XMP metadata');
  return Buffer.from(stream.contents).toString('utf8');
}

test('the invoice is read: profile, number, date, type', () => {
  assert.deepEqual(readInvoice(invoiceXml), {
    urn: 'urn:factur-x.eu:1p0:minimum',
    profile: 'MINIMUM',
    number: '2026/11/000042',
    issueDate: '20261111',
    typeCode: '380',
  });
});

test('every profile of Factur-X, ZUGFeRD and XRechnung is recognised by a token', () => {
  const cases: [string, string][] = [
    ['urn:factur-x.eu:1p0:minimum', 'MINIMUM'],
    ['urn:factur-x.eu:1p0:basicwl', 'BASIC WL'],
    ['urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic', 'BASIC'],
    ['urn:cen.eu:en16931:2017', 'EN 16931'],
    ['urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended', 'EXTENDED'],
    // ZUGFeRD writes its own version into the URN, and so does XRechnung: the
    // tokens have to survive a minor version nobody told us about.
    ['urn:cen.eu:en16931:2017#compliant#urn:zugferd.de:2p1:basic', 'BASIC'],
    ['urn:zugferd.de:2p3:minimum', 'MINIMUM'],
    ['urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0', 'XRECHNUNG'],
  ];
  for (const [urn, profile] of cases) assert.equal(readInvoice(withUrn(urn)).profile, profile, urn);
});

test('a profile PDFKiln does not know is refused by name', () => {
  const err = refusal(() => readInvoice(withUrn('urn:example:something:else')));
  assert.ok(err instanceof ArchiveError);
  assert.match(err.message, /urn:example:something:else/);
  assert.match(err.message, /MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED and XRECHNUNG/);
});

test('XML that is not an invoice, or not XML at all, is refused with the reason', () => {
  const ubl = '<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>';
  assert.match(refusal(() => readInvoice(new TextEncoder().encode(ubl))).message, /UBL invoice is a different format/);
  const truncated = new TextDecoder().decode(invoiceXml).slice(0, 900);
  assert.match(refusal(() => readInvoice(new TextEncoder().encode(truncated))).message, /cannot be read/);
  assert.match(refusal(() => readInvoice(new TextEncoder().encode('%PDF-1.7\nnot an invoice at all\n'))).message, /cannot be read/);
});

test('a DOCTYPE is refused: an invoice needs none, and it is the way in', () => {
  const text = new TextDecoder().decode(invoiceXml).replace(
    '<rsm:CrossIndustryInvoice',
    '<!DOCTYPE rsm:CrossIndustryInvoice [<!ENTITY x "y">]>\n<rsm:CrossIndustryInvoice',
  );
  const err = refusal(() => readInvoice(new TextEncoder().encode(text)));
  assert.ok(err instanceof ArchiveError);
  assert.match(err.message, /DOCTYPE/);
});

test('a missing profile, number, type or date is named', () => {
  const drop = (needle: string, by = ''): Error =>
    refusal(() => readInvoice(new TextEncoder().encode(new TextDecoder().decode(invoiceXml).replace(needle, by))));
  assert.match(drop('<ram:ID>urn:factur-x.eu:1p0:minimum</ram:ID>').message, /declares no profile/);
  assert.match(drop('<ram:ID>2026/11/000042</ram:ID>').message, /invoice number \(BT-1\)/);
  assert.match(drop('<ram:TypeCode>380</ram:TypeCode>').message, /type code \(BT-3\)/);
  assert.match(drop('<udt:DateTimeString format="102">20261111</udt:DateTimeString>').message, /issue date \(BT-2\)/);
  assert.match(drop('20261111', '11/11/2026').message, /not a date in format 102/);
  assert.match(drop('20261111', '20261332').message, /not a date in format 102/);
});

test('the file travels as its profile requires: Data for MINIMUM and BASIC WL, xrechnung.xml for XRECHNUNG', () => {
  assert.deepEqual(embedding('MINIMUM'), { fileName: 'factur-x.xml', afRelationship: 'Data' });
  assert.deepEqual(embedding('BASIC WL'), { fileName: 'factur-x.xml', afRelationship: 'Data' });
  for (const profile of ['BASIC', 'EN 16931', 'EXTENDED'] as const) {
    assert.deepEqual(embedding(profile), { fileName: 'factur-x.xml', afRelationship: 'Alternative' }, profile);
  }
  assert.deepEqual(embedding('XRECHNUNG'), { fileName: 'xrechnung.xml', afRelationship: 'Alternative' });
});

test('the options are checked before the render, each refusal naming its option', () => {
  assert.equal(archiveRequest(undefined, undefined, NATIVE), undefined);
  assert.deepEqual(archiveRequest('', undefined, NATIVE), { level: '3b' });
  assert.deepEqual(archiveRequest('2U', undefined, NATIVE), { level: '2u' });
  assert.match(refusal(() => archiveRequest('1b', undefined, NATIVE)).message, /^--pdfa: PDF\/A-1 forbids transparency/);
  assert.match(refusal(() => archiveRequest('4b', undefined, COMPATIBLE)).message, /^--kiln-pdfa: no such level "4b"/);
  assert.match(refusal(() => archiveRequest(undefined, join(dir, 'none.xml'), NATIVE)).message, /^--factur-x: cannot read .*none\.xml: no such file$/);
  assert.match(refusal(() => archiveRequest(undefined, '', NATIVE)).message, /^--factur-x needs the invoice's XML file/);
  assert.match(refusal(() => archiveRequest(undefined, join(fixtures, 'simple.html'), COMPATIBLE)).message, /^--kiln-factur-x: /);
  // An invoice travels in PDF/A-3: a level of part 2 cannot carry it.
  const part2 = refusal(() => archiveRequest('2b', invoicePath, NATIVE));
  assert.match(part2.message, /^--factur-x: an invoice travels in PDF\/A-3, and level 2b is part 2/);
  assert.match(part2.message, /Ask --pdfa for 3b or 3u/);
  // Without a level, an invoice gets 3b; with one of part 3, that one.
  assert.equal(archiveRequest(undefined, invoicePath, NATIVE)?.level, '3b');
  assert.equal(archiveRequest('3u', invoicePath, NATIVE)?.level, '3u');
  assert.equal(archiveRequest(undefined, invoicePath, NATIVE)?.invoice?.data.profile, 'MINIMUM');
});

test('the invoice is attached in PDF/A-3, named and related as its profile requires, the profile in the XMP', async () => {
  const cases: [string, string, string, string][] = [
    ['minimum.xml', 'urn:factur-x.eu:1p0:minimum', 'factur-x.xml', '/Data'],
    ['basicwl.xml', 'urn:factur-x.eu:1p0:basicwl', 'factur-x.xml', '/Data'],
    ['en16931.xml', 'urn:cen.eu:en16931:2017', 'factur-x.xml', '/Alternative'],
    ['xrechnung.xml', 'urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0', 'xrechnung.xml', '/Alternative'],
  ];
  for (const [file, urn, name, relationship] of cases) {
    const request = archiveRequest(undefined, invoiceFile(file, urn), NATIVE)!;
    const doc = await PDFDocument.load(await archive(simple, request, NATIVE), { updateMetadata: false });
    assert.deepEqual(associated(doc), [{ name, relationship }], urn);
    const packet = await xmpOf(doc);
    assert.match(packet, /<pdfaid:part>3<\/pdfaid:part>/, urn);
    assert.match(packet, new RegExp(`>${request.invoice!.data.profile}<|"${request.invoice!.data.profile}"`), `${urn}: the profile in the XMP`);
    assert.ok(packet.includes(name), `${urn}: the file's name in the XMP`);
  }
});

test('an invoice attached to a file twice is there once', async () => {
  const request = archiveRequest(undefined, invoicePath, NATIVE)!;
  const once = await archive(simple, request, NATIVE);
  const twice = await PDFDocument.load(await archive(once, request, NATIVE), { updateMetadata: false });
  assert.equal(associated(twice).length, 1);
});
