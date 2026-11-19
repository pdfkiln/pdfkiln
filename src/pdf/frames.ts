// The frames Chromium printed blank (src/engine/frames.ts), drawn into the
// PDF: each where the link laid over it lands, its content box inside its
// borders and padding, from the page it was printed on apart, and that
// page's links with it. A frame that runs over a page break has a link on
// each page: each shows its part of the frame. One that cannot be printed
// apart, or prints nothing, stays as Chromium left it.
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFPage, PDFString,
  clip, endPath, popGraphicsState, pushGraphicsState, rectangle, type PDFObject,
} from '@cantoo/pdf-lib';
import { SCALE_MARK, type FrameMark } from '../engine/frames.js';
import { READ } from './modules.js';

type Rect = [number, number, number, number];

const text = (o: PDFObject | undefined): string =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : '';

const rectOf = (d: PDFDict): Rect | null => {
  const r = d.lookupMaybe(PDFName.of('Rect'), PDFArray)?.asArray().map((v) => Number(v.toString()));
  if (!r || r.length !== 4 || r.some((v) => !Number.isFinite(v))) return null;
  return [Math.min(r[0]!, r[2]!), Math.min(r[1]!, r[3]!), Math.max(r[0]!, r[2]!), Math.max(r[1]!, r[3]!)];
};

const uriOf = (d: PDFDict): string => text(d.lookupMaybe(PDFName.of('A'), PDFDict)?.get(PDFName.of('URI')));

// The links laid over the frames, page by page in order and from the top
// of a page, taken out.
function takeMarks(doc: PDFDocument, hrefs: Set<string>): Map<string, { page: PDFPage; rect: Rect }[]> {
  const found = new Map<string, { page: PDFPage; rect: Rect }[]>();
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const here: [string, Rect][] = [];
    for (let k = (annots?.size() ?? 0) - 1; k >= 0; k--) {
      const a = annots!.lookupMaybe(k, PDFDict);
      const href = a && uriOf(a);
      if (!a || !href || !hrefs.has(href)) continue;
      annots!.remove(k);
      const rect = rectOf(a);
      // A degenerate rectangle: a frame hidden in print.
      if (rect && rect[2] - rect[0] >= 1 && rect[3] - rect[1] >= 1) here.push([href, rect]);
    }
    here.sort((a, b) => b[1][3] - a[1][3]);
    for (const [href, rect] of here) found.set(href, [...(found.get(href) ?? []), { page, rect }]);
  }
  return found;
}

// ptPerPx: the PDF's points per CSS pixel the print should have, 0.75 times
// its scale; the link of SCALE_MARK says what it had. printApart(mark,
// width, height): the frame printed on a page of its content's size, in
// CSS pixels; the calls may run together.
export async function placeFrames(
  doc: PDFDocument,
  marks: FrameMark[],
  ptPerPx: number,
  printApart: (mark: FrameMark, width: number, height: number) => Promise<Uint8Array | null>,
): Promise<void> {
  const spots = takeMarks(doc, new Set([...marks.map((m) => m.href), SCALE_MARK]));
  const scale = spots.get(SCALE_MARK)?.[0];
  const pt = scale ? (scale.rect[2] - scale.rect[0]) / 100 : ptPerPx;
  const jobs = marks.flatMap((mark) => {
    const parts = spots.get(mark.href);
    if (!parts?.length) return [];
    // The frame's border box: the first part's width, the parts' heights.
    const width = (parts[0]!.rect[2] - parts[0]!.rect[0]) / pt - mark.inset.left - mark.inset.right;
    const height = parts.reduce((h, p) => h + p.rect[3] - p.rect[1], 0) / pt - mark.inset.top - mark.inset.bottom;
    return width >= 1 && height >= 1 ? [{ mark, parts, width, height }] : [];
  });
  const printed = await Promise.all(jobs.map((j) => printApart(j.mark, j.width, j.height).catch(() => null)));
  for (const [i, { mark, parts, width, height }] of jobs.entries()) {
    try {
      await draw(doc, printed[i]!, mark, parts, width * pt, height * pt);
    } catch {
      // Left as Chromium left it.
    }
  }
}

async function draw(doc: PDFDocument, bytes: Uint8Array | null, mark: FrameMark, parts: { page: PDFPage; rect: Rect }[], w: number, h: number): Promise<void> {
  if (!bytes) return;
  const apart = await PDFDocument.load(bytes, READ);
  const source = apart.getPage(0);
  // A frame that prints nothing: Chromium writes its page without content.
  if (!source.node.Contents()) return;
  // Embedded now: pdf-lib would at the save, from a copy of the page that
  // nothing in the document holds, which prune() takes out first.
  const embedded = await doc.embedPage(source);
  await embedded.embed();
  // How much the frame's page grows: its own points are 0.75 a pixel.
  const grow = w / source.getWidth();
  const pt = w / (source.getWidth() / 0.75);
  let above = 0;
  for (const { page, rect } of parts) {
    const [x1, y1, x2, y2] = rect;
    // The content box's top, above this page for a part after the first.
    const top = y2 + above - mark.inset.top * pt;
    const left = x1 + mark.inset.left * pt;
    const clipTop = Math.min(y2, top);
    const clipBottom = Math.max(y1, top - h);
    above += y2 - y1;
    if (clipTop - clipBottom < 0.01) continue;
    page.pushOperators(pushGraphicsState(), rectangle(left, clipBottom, w, clipTop - clipBottom), clip(), endPath());
    page.drawPage(embedded, { x: left, y: top - h, width: w, height: h });
    page.pushOperators(popGraphicsState());
    // The frame's links, where they land on this part; printable, as PDF/A
    // wants an annotation to be (/F 4), and Chromium writes its own.
    const annots = source.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let k = 0; k < (annots?.size() ?? 0); k++) {
      const a = annots!.lookupMaybe(k, PDFDict);
      const uri = a && uriOf(a);
      const r = a && rectOf(a);
      if (!uri || !r) continue;
      const at: Rect = [
        Math.max(x1, left + r[0] * grow), Math.max(clipBottom, top - h + r[1] * grow),
        Math.min(x2, left + r[2] * grow), Math.min(clipTop, top - h + r[3] * grow),
      ];
      if (at[2] - at[0] < 0.01 || at[3] - at[1] < 0.01) continue;
      page.node.addAnnot(doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', F: 4, Rect: at, Border: [0, 0, 0],
        A: { S: 'URI', URI: PDFString.of(uri) },
      })));
    }
  }
}
