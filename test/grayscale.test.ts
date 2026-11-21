import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream, type PDFRef } from '@cantoo/pdf-lib';
import { grayContent, grayOf, qGray, toGray } from '../src/pdf/grayscale.js';

const N = (n: string) => PDFName.of(n);
const text = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString('latin1') : undefined);
const rgb = () => 'rgb' as const;

test("colours in grey with Qt's weights", () => {
  assert.equal(qGray(255, 0, 0), 87);
  assert.equal(qGray(0, 255, 0), 127);
  assert.equal(qGray(0, 0, 255), 39);
  assert.equal(qGray(255, 255, 255), 255);
  assert.equal(grayOf([1, 1, 1]), 1);
  assert.equal(grayOf([0.5]), 0.5);
  // CMYK: black, and no ink.
  assert.equal(grayOf([0, 0, 0, 1]), 0);
  assert.equal(grayOf([0, 0, 0, 0]), 1);
});

test('a content stream: its colour operators in grey, the rest as it is', () => {
  const out = text(grayContent(Buffer.from(
    'q 1 0 0 rg 0 0 1 RG 0 0 10 10 re B Q\n'
    + '/CS0 cs 0 1 0 scn /Pattern CS /P0 SCN 0 0 0 1 k\n'
    + 'BT /F1 12 Tf (1 0 0 rg \\) 1 rg) Tj <31> Tj ET % 1 0 0 rg\n'
    + 'BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x01 rg\x02 EI\n'
    + '/DeviceRGB CS .2 .4 .6 SC 1 0 0 rg 0.5 0.5 0.5 sc',
  ), (name) => (name === 'CS0' || name === 'DeviceRGB' ? 'rgb' : name === 'Pattern' ? 'pattern' : 'other')));
  assert.equal(out,
    'q 0.3412 g 0.1529 G 0 0 10 10 re B Q\n'
    + '/DeviceGray cs 0.498 scn /Pattern CS /P0 SCN 0 g\n'
    + 'BT /F1 12 Tf (1 0 0 rg \\) 1 rg) Tj <31> Tj ET % 1 0 0 rg\n'
    + 'BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x01 rg\x02 EI\n'
    // After rg, sc takes three components until the space changes.
    + `/DeviceGray CS ${String(Math.round((qGray(51, 102, 153) / 255) * 1e4) / 1e4)} SC 0.3412 g 0.502 sc`);
  // Nothing to change: nothing returned.
  assert.equal(grayContent(Buffer.from('0.5 g BT (Hi) Tj ET'), rgb), undefined);
});

test('a PDF in grey: shadings, functions, images, groups and their masks', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const page = doc.addPage([100, 100]);
  const dict = (o: object) => ctx.obj(o as Record<string, never>);
  const shading = (fn: unknown) => ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [0, 0, 1, 0], Function: fn as never });
  const shared = ctx.register(dict({ FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }));
  const type4 = ctx.register(PDFRawStream.of(dict({ FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1] }), deflateSync('{ dup dup }')));
  (ctx.lookup(type4) as PDFStream).dict.set(N('Filter'), N('FlateDecode'));
  const image = (entries: Record<string, unknown>, data: Uint8Array) => ctx.register(PDFRawStream.of(dict({ Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, BitsPerComponent: 8, ...entries }), data));
  const red = image({ ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' }, deflateSync(Buffer.from([255, 0, 0, 0, 0, 255])));
  const jpeg = image({ ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' }, Buffer.from('not decoded here'));
  const unknown = image({ ColorSpace: 'DeviceRGB', Filter: 'LZWDecode' }, Buffer.from([0]));
  const indexed = image({ ColorSpace: ctx.obj([N('Indexed'), N('DeviceRGB'), 1, ctx.register(ctx.flateStream(Buffer.from([255, 0, 0, 0, 0, 255])))]) }, Buffer.from([0, 1]));
  const group = ctx.register(PDFRawStream.of(dict({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Group: { S: 'Transparency', CS: 'DeviceRGB' } }), Buffer.from('1 1 1 rg 0 0 1 1 re f')));
  const mask = dict({ Type: 'Mask', S: 'Luminosity', G: group, BC: [1, 0, 0] });
  page.node.set(N('Resources'), ctx.obj({
    Pattern: {
      P0: { PatternType: 2, Shading: shading({ FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 }) },
      P1: { PatternType: 2, Shading: shading({ FunctionType: 3, Domain: [0, 1], Bounds: [0.5], Encode: [0, 1, 0, 1], Functions: [{ FunctionType: 2, Domain: [0, 1], C0: [0, 1, 0], C1: [1, 1, 1], N: 1 }, { FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [0, 0, 0], N: 1 }] }) },
      P2: { PatternType: 2, Shading: shading(type4) },
      P3: { PatternType: 2, Shading: shading({ FunctionType: 0, Domain: [0, 1] }) },
      // One function for two shadings, one referenced by a stitching function.
      P4: { PatternType: 2, Shading: shading(shared) },
      P5: { PatternType: 2, Shading: shading(shared) },
      P6: { PatternType: 2, Shading: shading({ FunctionType: 3, Domain: [0, 1], Bounds: [], Encode: [0, 1], Functions: [shared] }) },
    },
    ExtGState: { M: { SMask: mask } },
    XObject: { Red: red, Jpeg: jpeg, Unknown: unknown, Indexed: indexed, Group: group },
  }));
  page.node.set(N('Contents'), ctx.register(ctx.flateStream('1 0 0 rg 0 0 10 10 re f /Red Do')));
  const asked: [number, number][] = [];
  await toGray(doc, async (_data, w, h) => (asked.push([w, h]), new Uint8Array([10, 20])));

  const res = page.node.Resources()!;
  const shadingOf = (p: string) => res.lookup(N('Pattern'), PDFDict).lookup(N(p), PDFDict).lookup(N('Shading'), PDFDict);
  const numbers = (a: PDFArray | undefined) => a?.asArray().map((x) => (x as PDFNumber).asNumber());
  const fnOf = (p: string) => shadingOf(p).lookup(N('Function'), PDFDict);
  assert.equal(shadingOf('P0').get(N('ColorSpace')), N('DeviceGray'));
  assert.deepEqual(numbers(fnOf('P0').lookupMaybe(N('C0'), PDFArray)), [87 / 255]);
  assert.deepEqual(numbers(fnOf('P0').lookupMaybe(N('C1'), PDFArray)), [39 / 255]);
  const parts = fnOf('P1').lookup(N('Functions'), PDFArray).asArray().map((f) => numbers((f as PDFDict).lookupMaybe(N('C0'), PDFArray)));
  assert.deepEqual(parts, [[127 / 255], [1]]);
  // A PostScript function: its grey computed at its end.
  const ps = shadingOf('P2').lookup(N('Function'), PDFStream) as PDFRawStream;
  assert.equal(text(decodePDFRawStream(ps).decode()), '{ dup dup 0.15625 mul exch 0.5 mul add exch 0.34375 mul add }');
  assert.deepEqual(numbers(ps.dict.lookupMaybe(N('Range'), PDFArray)), [0, 1]);
  assert.equal(shadingOf('P2').get(N('ColorSpace')), N('DeviceGray'));
  // A sampled function: left in colour, its shading too.
  assert.equal(shadingOf('P3').get(N('ColorSpace')), N('DeviceRGB'));
  for (const p of ['P4', 'P5', 'P6']) assert.equal(shadingOf(p).get(N('ColorSpace')), N('DeviceGray'), p);
  assert.deepEqual(numbers(fnOf('P4').lookupMaybe(N('C0'), PDFArray)), [87 / 255]);
  // The shared function itself stays in colour, for what else uses it.
  assert.deepEqual(numbers(ctx.lookup(shared, PDFDict).lookupMaybe(N('C0'), PDFArray)), [1, 0, 0]);
  const sub = fnOf('P6').lookup(N('Functions'), PDFArray).lookup(0, PDFDict);
  assert.deepEqual(numbers(sub.lookupMaybe(N('C0'), PDFArray)), [87 / 255]);

  const stream = (r: PDFRef) => ctx.lookup(r) as PDFRawStream;
  assert.equal(stream(red).dict.get(N('ColorSpace')), N('DeviceGray'));
  assert.deepEqual([...inflateSync(stream(red).contents)], [87, 39]);
  assert.deepEqual(asked, [[2, 1]]);
  assert.equal(stream(jpeg).dict.get(N('Filter')), N('FlateDecode'));
  assert.deepEqual([...inflateSync(stream(jpeg).contents)], [10, 20]);
  assert.equal(stream(unknown).dict.get(N('ColorSpace')), N('DeviceRGB'));
  const space = stream(indexed).dict.lookup(N('ColorSpace'), PDFArray);
  assert.equal(space.get(1), N('DeviceGray'));
  assert.equal(space.lookup(3)!.toString(), '<5727>');

  assert.equal(stream(group).dict.lookup(N('Group'), PDFDict).get(N('CS')), N('DeviceGray'));
  assert.equal(text(decodePDFRawStream(stream(group)).decode()), '1 g 0 0 1 1 re f');
  assert.deepEqual(numbers(mask.lookupMaybe(N('BC'), PDFArray)), [87 / 255]);
  const contents = ctx.lookup(page.node.get(N('Contents')) as PDFRef) as PDFStream;
  assert.equal(text(decodePDFRawStream(contents as PDFRawStream).decode()), '0.3412 g 0 0 10 10 re f /Red Do');
});
