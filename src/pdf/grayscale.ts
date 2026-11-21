// --grayscale as wkhtmltopdf writes it: its Qt puts every colour of the PDF
// in grey, with qGray's weights (11, 16 and 5 in 32), images included, and
// the text stays text. Done on the assembled PDF: a CSS filter makes
// Chromium print each page as one image. Converted: the colours of rg, RG,
// k and K, and of sc and scn in an RGB or CMYK space; shadings and their
// functions; images; the colour space of transparency groups. What is
// neither (another colour space, a sampled function, an image it cannot
// read) keeps its colour.
import { deflateSync, inflateSync } from 'node:zlib';
import {
  decodePDFRawStream, PDFArray, PDFBool, PDFDict, PDFFlateStream, PDFHexString, PDFName, PDFNumber,
  PDFRawStream, PDFRef, PDFStream, PDFString, type PDFContext, type PDFDocument, type PDFObject,
} from '@cantoo/pdf-lib';

// Grey bytes of a JPEG, which only a browser decodes here, or undefined.
export type JpegToGray = (data: Uint8Array, width: number, height: number) => Promise<Uint8Array | undefined>;

const N = (name: string) => PDFName.of(name);
type Kind = 'gray' | 'rgb' | 'cmyk' | 'pattern' | 'other';

// Qt's qGray, on 8-bit components.
export const qGray = (r: number, g: number, b: number): number => (r * 11 + g * 16 + b * 5) >> 5;
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

// The grey of a colour of components 0 to 1: RGB, or CMYK as QColor turns it
// into RGB.
export function grayOf(c: number[]): number {
  if (c.length === 3) return qGray(byte(c[0]!), byte(c[1]!), byte(c[2]!)) / 255;
  if (c.length === 4) {
    const k = 1 - c[3]!;
    return qGray(byte((1 - c[0]!) * k), byte((1 - c[1]!) * k), byte((1 - c[2]!) * k)) / 255;
  }
  return c[0] ?? 0;
}

const fmt = (v: number) => String(Math.round(v * 10000) / 10000);

function kindOf(ctx: PDFContext, space: PDFObject | undefined, resources?: PDFDict): Kind {
  const o = space instanceof PDFRef ? ctx.lookup(space) : space;
  if (o instanceof PDFName) {
    if (o === N('DeviceRGB') || o === N('RGB')) return 'rgb';
    if (o === N('DeviceCMYK') || o === N('CMYK')) return 'cmyk';
    if (o === N('DeviceGray') || o === N('G')) return 'gray';
    if (o === N('Pattern')) return 'pattern';
    const named = resources?.lookupMaybe(N('ColorSpace'), PDFDict)?.get(o);
    return named ? kindOf(ctx, named) : 'other';
  }
  if (o instanceof PDFArray && o.size()) {
    const head = o.lookup(0);
    if (head === N('CalRGB')) return 'rgb';
    if (head === N('CalGray')) return 'gray';
    if (head === N('Pattern')) return 'pattern';
    if (head === N('ICCBased')) {
      const n = o.lookupMaybe(1, PDFStream)?.dict.lookupMaybe(N('N'), PDFNumber)?.asNumber();
      return n === 3 ? 'rgb' : n === 4 ? 'cmyk' : n === 1 ? 'gray' : 'other';
    }
  }
  return 'other';
}

// The decoded bytes of a stream, or undefined for a filter pdf-lib does not
// decode.
function bytesOf(s: PDFStream): Uint8Array | undefined {
  try {
    if (s instanceof PDFFlateStream) return s.getUnencodedContents();
    if (s instanceof PDFRawStream) return s.dict.has(N('Filter')) ? decodePDFRawStream(s).decode() : s.contents;
  } catch {
    // An unknown filter: left as it is.
  }
  return undefined;
}

function replace(ctx: PDFContext, ref: PDFRef, s: PDFStream, data: Uint8Array, set: [string, PDFObject][] = []): void {
  const dict = s.dict.clone(ctx);
  for (const k of ['Filter', 'DecodeParms', 'ColorTransform', 'Length']) dict.delete(N(k));
  for (const [k, v] of set) dict.set(N(k), v);
  dict.set(N('Filter'), N('FlateDecode'));
  ctx.assign(ref, PDFRawStream.of(dict, deflateSync(data)));
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIMS = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
interface Token { start: number; end: number; op: boolean; num?: number; name?: string }

// The tokens of a content stream: operands and operators, strings, arrays
// and dictionaries as single opaque operands; an inline image's data
// skipped up to its EI.
function* tokens(b: Uint8Array): Generator<Token> {
  let i = 0;
  const regular = () => {
    while (i < b.length && !WS.has(b[i]!) && !DELIMS.has(b[i]!)) i++;
  };
  while (i < b.length) {
    const c = b[i]!;
    const start = i;
    if (WS.has(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < b.length && b[i] !== 10 && b[i] !== 13) i++;
    } else if (c === 0x28) {
      for (let depth = 0; i < b.length;) {
        const d = b[i++];
        if (d === 0x5c) i++;
        else if (d === 0x28) depth++;
        else if (d === 0x29 && --depth === 0) break;
      }
      yield { start, end: i, op: false };
    } else if (c === 0x3c && b[i + 1] !== 0x3c) {
      while (i < b.length && b[i] !== 0x3e) i++;
      i++;
      yield { start, end: i, op: false };
    } else if (c === 0x2f) {
      i++;
      regular();
      yield { start, end: i, op: false, name: Buffer.from(b.subarray(start + 1, i)).toString('latin1') };
    } else if (DELIMS.has(c)) {
      // << >> [ ] { } and a stray ) or >.
      i += (c === 0x3c || c === 0x3e) && b[i + 1] === c ? 2 : 1;
      yield { start, end: i, op: false };
    } else {
      regular();
      const text = Buffer.from(b.subarray(start, i)).toString('latin1');
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
        yield { start, end: i, op: false, num: Number(text) };
      } else if (text === 'ID') {
        // Inline image data, up to EI between white space.
        let j = i + 1;
        while (j + 2 <= b.length && !(WS.has(b[j - 1]!) && b[j] === 0x45 && b[j + 1] === 0x49 && (j + 2 === b.length || WS.has(b[j + 2]!)))) j++;
        i = Math.min(b.length, j + 2);
        yield { start, end: i, op: true };
      } else {
        yield { start, end: i, op: true };
      }
    }
  }
}

// A content stream in grey, or undefined when it has no colour to change.
export function grayContent(b: Uint8Array, space: (name: string) => Kind): Uint8Array | undefined {
  const edits: [number, number, string][] = [];
  let operands: Token[] = [];
  let state = { fill: 'gray' as Kind, stroke: 'gray' as Kind };
  const saved: (typeof state)[] = [];
  const values = (n: number) => (operands.length === n && operands.every((t) => t.num !== undefined) ? operands.map((t) => t.num!) : undefined);
  for (const t of tokens(b)) {
    if (!t.op) {
      operands.push(t);
      continue;
    }
    const op = Buffer.from(b.subarray(t.start, t.end)).toString('latin1');
    const stroke = op === op.toUpperCase();
    const key = stroke ? 'stroke' : 'fill';
    switch (op) {
      case 'q':
        saved.push({ ...state });
        break;
      case 'Q':
        state = saved.pop() ?? state;
        break;
      case 'g': case 'G':
        state[key] = 'gray';
        break;
      case 'rg': case 'RG': case 'k': case 'K': {
        const v = values(op.toLowerCase() === 'rg' ? 3 : 4);
        if (v) edits.push([operands[0]!.start, t.end, `${fmt(grayOf(v))} ${stroke ? 'G' : 'g'}`]);
        state[key] = op.toLowerCase() === 'rg' ? 'rgb' : 'cmyk';
        break;
      }
      case 'cs': case 'CS': {
        const name = operands.length === 1 ? operands[0]!.name : undefined;
        const kind = name === undefined ? 'other' : space(name);
        if (kind === 'rgb' || kind === 'cmyk') edits.push([operands[0]!.start, operands[0]!.end, '/DeviceGray']);
        state[key] = kind;
        break;
      }
      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const kind = state[key];
        const v = kind === 'rgb' ? values(3) : kind === 'cmyk' ? values(4) : undefined;
        if (v) edits.push([operands[0]!.start, t.end, `${fmt(grayOf(v))} ${op}`]);
        break;
      }
    }
    operands = [];
  }
  if (!edits.length) return undefined;
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const [start, end, text] of edits) {
    parts.push(b.subarray(at, start), Buffer.from(text, 'latin1'));
    at = end;
  }
  parts.push(b.subarray(at));
  return Buffer.concat(parts);
}

// A function of shading for grey, as a new object, or undefined.
function grayFunction(ctx: PDFContext, f: PDFObject | undefined, kind: 'rgb' | 'cmyk'): PDFObject | undefined {
  const o = f instanceof PDFRef ? ctx.lookup(f) : f;
  const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : undefined;
  const type = dict?.lookupMaybe(N('FunctionType'), PDFNumber)?.asNumber();
  const n = kind === 'rgb' ? 3 : 4;
  const range = (d: PDFDict) => {
    if (d.has(N('Range'))) d.set(N('Range'), ctx.obj([0, 1]));
  };
  if (type === 2 && o instanceof PDFDict) {
    const c = (key: string) => {
      const a = o.lookupMaybe(N(key), PDFArray);
      const v = a?.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN));
      return v && v.length === n && v.every((x) => !Number.isNaN(x)) ? v : undefined;
    };
    const [c0, c1] = [c('C0'), c('C1')];
    if (!c0 || !c1) return undefined;
    const out = o.clone(ctx);
    out.set(N('C0'), ctx.obj([grayOf(c0)]));
    out.set(N('C1'), ctx.obj([grayOf(c1)]));
    range(out);
    return out;
  }
  if (type === 3 && o instanceof PDFDict) {
    const parts = o.lookupMaybe(N('Functions'), PDFArray)?.asArray().map((x) => [x, grayFunction(ctx, x, kind)] as const);
    if (!parts || parts.some(([, g]) => g === undefined)) return undefined;
    const out = o.clone(ctx);
    // New objects: one that was referenced may serve elsewhere in colour.
    out.set(N('Functions'), ctx.obj(parts.map(([x, g]) => (x instanceof PDFRef || g instanceof PDFStream ? ctx.register(g!) : g!))));
    range(out);
    return out;
  }
  if (type === 4 && o instanceof PDFStream) {
    const code = bytesOf(o);
    const text = code && Buffer.from(code).toString('latin1');
    const close = text?.lastIndexOf('}') ?? -1;
    if (!text || close < 0) return undefined;
    // r g b, or c m y k, on the stack: their grey in their place.
    const tail = kind === 'rgb'
      ? ' 0.15625 mul exch 0.5 mul add exch 0.34375 mul add'
      : ' 1 exch sub 4 1 roll 0.15625 mul exch 0.5 mul add exch 0.34375 mul add 1 exch sub mul';
    const dict2 = o.dict.clone(ctx);
    range(dict2);
    for (const k of ['Filter', 'DecodeParms', 'Length']) dict2.delete(N(k));
    dict2.set(N('Filter'), N('FlateDecode'));
    return PDFRawStream.of(dict2, deflateSync(Buffer.from(`${text.slice(0, close).trimEnd()}${tail} ${text.slice(close)}`, 'latin1')));
  }
  return undefined;
}

function grayShading(ctx: PDFContext, d: PDFDict): void {
  const kind = kindOf(ctx, d.get(N('ColorSpace')));
  if (kind !== 'rgb' && kind !== 'cmyk') return;
  const f = d.get(N('Function'));
  // Mesh shadings without a function carry their colours in their data.
  const fn = grayFunction(ctx, f, kind);
  if (!fn) return;
  // A new object: the function may serve another shading, still in colour.
  d.set(N('Function'), f instanceof PDFRef || fn instanceof PDFStream ? ctx.register(fn) : fn);
  d.set(N('ColorSpace'), N('DeviceGray'));
  const bg = d.lookupMaybe(N('Background'), PDFArray)?.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
  if (bg) d.set(N('Background'), ctx.obj([grayOf(bg)]));
}

// The bytes of a lookup table of an Indexed colour space.
function tableOf(ctx: PDFContext, o: PDFObject | undefined): Uint8Array | undefined {
  const t = o instanceof PDFRef ? ctx.lookup(o) : o;
  if (t instanceof PDFString || t instanceof PDFHexString) return t.asBytes();
  if (t instanceof PDFStream) return bytesOf(t);
  return undefined;
}

async function grayImage(ctx: PDFContext, ref: PDFRef, s: PDFStream, jpeg: JpegToGray): Promise<void> {
  const d = s.dict;
  if (d.get(N('ImageMask')) === PDFBool.True || d.has(N('Decode'))) return;
  const num = (k: string) => d.lookupMaybe(N(k), PDFNumber)?.asNumber();
  const [w, h, bpc] = [num('Width'), num('Height'), num('BitsPerComponent')];
  if (!w || !h) return;
  const space = d.get(N('ColorSpace'));
  const cs = space instanceof PDFRef ? ctx.lookup(space) : space;
  // An Indexed space: its table in grey, the data as it is.
  if (cs instanceof PDFArray && cs.lookup(0) === N('Indexed')) {
    const base = kindOf(ctx, cs.get(1));
    const table = tableOf(ctx, cs.get(3));
    const n = base === 'rgb' ? 3 : base === 'cmyk' ? 4 : 0;
    if (!n || !table) return;
    const gray = new Uint8Array(Math.floor(table.length / n));
    for (let i = 0; i < gray.length; i++) gray[i] = byte(grayOf([...table.subarray(i * n, i * n + n)].map((x) => x / 255)));
    const out = d.clone(ctx);
    out.set(N('ColorSpace'), ctx.obj([N('Indexed'), N('DeviceGray'), cs.get(2)!, PDFHexString.of(Buffer.from(gray).toString('hex'))]));
    ctx.assign(ref, s instanceof PDFRawStream ? PDFRawStream.of(out, s.contents) : s);
    return;
  }
  const kind = kindOf(ctx, cs);
  if ((kind !== 'rgb' && kind !== 'cmyk') || bpc !== 8) return;
  const filter = d.get(N('Filter'));
  const filters = filter instanceof PDFArray ? filter.asArray() : filter ? [filter] : [];
  let gray: Uint8Array | undefined;
  if (filters.length === 1 && filters[0] === N('DCTDecode') && s instanceof PDFRawStream) {
    if (kind === 'rgb') gray = await jpeg(s.contents, w, h);
  } else if (filters.every((x) => x === N('FlateDecode')) && !d.has(N('DecodeParms'))) {
    let data: Uint8Array | undefined;
    try {
      data = s instanceof PDFRawStream ? (filters.length ? inflateSync(s.contents) : s.contents) : bytesOf(s);
    } catch {
      return;
    }
    const n = kind === 'rgb' ? 3 : 4;
    if (!data || data.length < w * h * n) return;
    gray = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < gray.length; i += n, j++) {
      gray[j] = n === 3
        ? qGray(data[i]!, data[i + 1]!, data[i + 2]!)
        : byte(grayOf([data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255, data[i + 3]! / 255]));
    }
  }
  if (gray) replace(ctx, ref, s, gray, [['ColorSpace', N('DeviceGray')]]);
}

// Every dictionary and array under an object, streams' dictionaries
// included, references not followed.
function walk(o: PDFObject | undefined, visit: (d: PDFDict) => void, seen = new Set<PDFObject>()): void {
  if (!o || seen.has(o)) return;
  if (o instanceof PDFStream) return walk(o.dict, visit, seen);
  if (o instanceof PDFDict) {
    seen.add(o);
    visit(o);
    for (const [, v] of o.entries()) walk(v, visit, seen);
  } else if (o instanceof PDFArray) {
    seen.add(o);
    for (const v of o.asArray()) walk(v, visit, seen);
  }
}

export async function toGray(doc: PDFDocument, jpeg: JpegToGray): Promise<void> {
  // Embedded pages (headers and footers) become objects here.
  await doc.flush();
  const ctx = doc.context;
  const objects = ctx.enumerateIndirectObjects();
  // Shadings, transparency groups and the backdrops of their soft masks.
  const groups = new Set<PDFDict>();
  const masks: PDFDict[] = [];
  const seen = new Set<PDFObject>();
  for (const [, o] of objects) {
    walk(o, (d) => {
      if (d.has(N('ShadingType'))) grayShading(ctx, d);
      else if (d.get(N('S')) === N('Transparency') && d.has(N('CS'))) {
        const k = kindOf(ctx, d.get(N('CS')));
        if (k === 'rgb' || k === 'cmyk') groups.add(d);
      } else if (d.has(N('BC')) && d.has(N('G'))) masks.push(d);
    }, seen);
  }
  for (const m of masks) {
    const g = m.lookupMaybe(N('G'), PDFStream)?.dict.lookupMaybe(N('Group'), PDFDict);
    const bc = m.lookupMaybe(N('BC'), PDFArray)?.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
    if (g && groups.has(g) && bc) m.set(N('BC'), ctx.obj([grayOf(bc)]));
  }
  for (const g of groups) g.set(N('CS'), N('DeviceGray'));

  // Content streams, each with the resources its colour spaces are named in.
  const contents = new Map<string, [PDFRef, PDFDict | undefined]>();
  const add = (r: PDFObject | undefined, res: PDFDict | undefined) => {
    if (r instanceof PDFRef && !contents.has(r.tag)) contents.set(r.tag, [r, res]);
  };
  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    const c = page.node.get(N('Contents'));
    if (c instanceof PDFArray) c.asArray().forEach((r) => add(r, res));
    else add(c, res);
  }
  const images: [PDFRef, PDFStream][] = [];
  for (const [ref, o] of objects) {
    if (o instanceof PDFStream) {
      const st = o.dict.get(N('Subtype'));
      if (st === N('Image')) images.push([ref, o]);
      else if (st === N('Form') || o.dict.has(N('PatternType'))) add(ref, o.dict.lookupMaybe(N('Resources'), PDFDict));
    } else if (o instanceof PDFDict && o.get(N('Subtype')) === N('Type3')) {
      const res = o.lookupMaybe(N('Resources'), PDFDict);
      for (const [, r] of o.lookupMaybe(N('CharProcs'), PDFDict)?.entries() ?? []) add(r, res);
    }
  }
  for (const [ref, res] of contents.values()) {
    const s = ctx.lookup(ref);
    if (!(s instanceof PDFStream)) continue;
    const b = bytesOf(s);
    const out = b && grayContent(b, (name) => kindOf(ctx, N(name), res));
    if (out) replace(ctx, ref, s, out);
  }
  for (const [ref, s] of images) await grayImage(ctx, ref, s, jpeg);
}
