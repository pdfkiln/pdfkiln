// Puts the PDFs printed by Chromium together: one document, in order, with
// wkhtmltopdf's page sizes, its outline, its title, and the header and
// footer stamps drawn on each page. The native interface adds PDFs made
// elsewhere, its PDF inputs, whose pages go in as they are.
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream, PDFString,
  type PDFObject,
} from '@cantoo/pdf-lib';

export interface OutlineItem {
  title: string;
  page: number; // index in its own PDF
  dest: PDFArray | null; // [page /XYZ x y z] of its own PDF
  children: OutlineItem[];
}

const text = (o: PDFObject | undefined): string =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : '';

// A named destination, from the catalog's /Dests dictionary (PDF 1.1) or
// its /Names /Dests tree: the array, or a dictionary that holds it as /D.
function namedDest(doc: PDFDocument, name: string): PDFObject | undefined {
  const old = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict)?.get(PDFName.of(name));
  if (old) return old;
  // The tree: leaves of /Names [key value ...], nodes of /Kids.
  const walk = (node: PDFDict | undefined, depth: number): PDFObject | undefined => {
    if (!node || depth > 32) return undefined;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let i = 0; names && i + 1 < names.size(); i += 2) if (text(names.lookup(i)) === name) return names.get(i + 1);
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      const found = walk(kids.lookupMaybe(i, PDFDict), depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('Dests'), PDFDict), 0);
}

// A destination as an explicit array [page /XYZ x y z], from what a link or
// a bookmark gives: the array, a name or a string naming one, or a
// dictionary holding it as /D.
export function resolveDest(doc: PDFDocument, d: PDFObject | undefined, depth = 0): PDFArray | undefined {
  if (d === undefined || depth > 4) return undefined;
  const v = d instanceof PDFRef ? doc.context.lookup(d) : d;
  if (v instanceof PDFArray) return v;
  if (v instanceof PDFDict) return resolveDest(doc, v.get(PDFName.of('D')), depth + 1);
  if (v instanceof PDFName || v instanceof PDFString || v instanceof PDFHexString) return resolveDest(doc, namedDest(doc, v.decodeText()), depth + 1);
  return undefined;
}

// Where a link or a bookmark goes: its /Dest, or the /D of its GoTo action;
// nothing for an action of another kind (a URI, a script).
function destOf(d: PDFDict): PDFObject | undefined {
  const action = d.lookupMaybe(PDFName.of('A'), PDFDict);
  if (action) return action.lookup(PDFName.of('S')) === PDFName.of('GoTo') ? action.get(PDFName.of('D')) : undefined;
  return d.get(PDFName.of('Dest'));
}

// The outline of a PDF: Chromium's, with generateDocumentOutline, gives
// explicit destinations [page /XYZ x y z]; a PDF made elsewhere may name
// them, or go to them by a GoTo action.
export function readOutline(doc: PDFDocument): OutlineItem[] {
  const pages = doc.getPages().map((p) => p.ref.toString());
  const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const walk = (first: PDFDict | undefined): OutlineItem[] => {
    const items: OutlineItem[] = [];
    for (let d = first, guard = 0; d && guard < 100000; d = d.lookupMaybe(PDFName.of('Next'), PDFDict), guard++) {
      const dest = resolveDest(doc, destOf(d)) ?? null;
      const ref = dest?.get(0);
      items.push({
        title: text(d.lookup(PDFName.of('Title'))),
        page: ref instanceof PDFRef ? pages.indexOf(ref.toString()) : -1,
        dest,
        children: walk(d.lookupMaybe(PDFName.of('First'), PDFDict)),
      });
    }
    return items;
  };
  return outlines ? walk(outlines.lookupMaybe(PDFName.of('First'), PDFDict)) : [];
}

// A bookmark Chromium titles with its heading's text twice, when a page
// break pushes the heading to the next page ("InstallationInstallation",
// measured with Chromium 157 on a heading kept with what follows it by
// break-after: avoid): it gets the text once. Only a title that is a
// heading of the page twice over, and not itself a heading's text, changes:
// a heading named "TomTom" keeps its name. headings: the page's headings,
// as rendered and as written (innerText, textContent).
export function undoubleTitles(items: OutlineItem[], headings: string[]): OutlineItem[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const texts = new Set(headings.map(norm));
  const fix = (list: OutlineItem[]): OutlineItem[] => list.map((it) => {
    const t = norm(it.title);
    const half = t.slice(0, t.length / 2);
    const title = t.length % 2 === 0 && half && t === half + half && texts.has(half) && !texts.has(t) ? half : it.title;
    return { ...it, title, children: fix(it.children) };
  });
  return fix(items);
}

// Chromium writes the named destinations of internal links in the page's
// CSS points, unscaled and without the margins (measured with Chromium
// 156: an element at 200 x 300 px lands at /XYZ 150 (height - 225)
// whatever the margins and the scale). Puts them where the page shows it.
export function fixDests(doc: PDFDocument, leftPt: number, topPt: number, scale: number): void {
  const dests = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (!dests) return;
  const heights = new Map(doc.getPages().map((p) => [p.ref.toString(), p.getHeight()]));
  for (const [, value] of dests.entries()) {
    const arr = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (!(arr instanceof PDFArray) || arr.size() < 4 || arr.get(1) !== PDFName.of('XYZ')) continue;
    const h = heights.get(arr.get(0).toString());
    const x = arr.get(2);
    const y = arr.get(3);
    if (h === undefined || !(x instanceof PDFNumber) || !(y instanceof PDFNumber)) continue;
    arr.set(2, PDFNumber.of(leftPt + scale * x.asNumber()));
    arr.set(3, PDFNumber.of(h - (topPt + scale * (h - y.asNumber()))));
  }
}

// Removes what nothing references any more: the structure tree after it
// is unlinked, the objects of pages that were replaced.
export function prune(doc: PDFDocument): void {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt, ctx.trailerInfo.ID]
    .filter((o): o is PDFObject => Boolean(o));
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream || o instanceof PDFRawStream) {
      stack.push(o.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

export interface Part {
  doc: PDFDocument;
  outline: OutlineItem[] | null; // null: not in the outline
  // A PDF made elsewhere, not printed by Chromium.
  pdf?: boolean;
}

// The links of a PDF made elsewhere to its own pages, as page numbers:
// pdf-lib copies the page a link points to a second time, outside the page
// tree, and a named destination stays a name of a tree it does not copy
// (measured, pdf-lib 2.11.1): the links went nowhere. unpinLinks makes the
// numbers the copied pages again. A link to no page of the file is dropped;
// the others (a URI, another file) stay as they are.
function pinLinks(doc: PDFDocument): void {
  const index = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]));
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = (annots?.size() ?? 0) - 1; annots && i >= 0; i--) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (!a || a.lookup(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
      const action = a.lookupMaybe(PDFName.of('A'), PDFDict);
      if (action && action.lookup(PDFName.of('S')) !== PDFName.of('GoTo')) continue;
      const dest = resolveDest(doc, destOf(a));
      const target = dest?.get(0);
      const n = target instanceof PDFRef ? index.get(target.toString()) : undefined;
      if (!dest || n === undefined) {
        annots.remove(i);
        continue;
      }
      const pinned = doc.context.obj([PDFNumber.of(n)]);
      for (let j = 1; j < dest.size(); j++) pinned.push(dest.get(j));
      a.delete(PDFName.of('A'));
      a.set(PDFName.of('Dest'), pinned);
    }
  }
}

function unpinLinks(pages: PDFPage[]): void {
  for (const page of pages) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = 0; annots && i < annots.size(); i++) {
      const dest = annots.lookupMaybe(i, PDFDict)?.lookupMaybe(PDFName.of('Dest'), PDFArray);
      const n = dest?.get(0);
      const target = n instanceof PDFNumber ? pages[n.asNumber()] : undefined;
      if (target) dest!.set(0, target.ref);
    }
  }
}

export interface Assembled {
  doc: PDFDocument;
  pages: PDFPage[];
  // Index of the first page of each part in `pages`.
  offsets: number[];
}

// Appends every part to the first, keeping the named destinations of
// internal links (Chromium's /Dests dictionary), renamed per part. A PDF made
// elsewhere is never the base: what its catalog holds (a script run on
// opening, attached files, a form, its metadata) would come along. A new
// document takes its pages then, as it takes the others'.
export async function merge(parts: Part[], keepStructure: boolean): Promise<Assembled> {
  const fresh = Boolean(parts[0]!.pdf);
  const base = fresh ? await PDFDocument.create({ updateMetadata: false }) : parts[0]!.doc;
  if (fresh) {
    base.setCreationDate(new Date());
    base.setModificationDate(new Date());
  }
  const ctx = base.context;
  if (!keepStructure) {
    base.catalog.delete(PDFName.of('StructTreeRoot'));
    base.catalog.delete(PDFName.of('MarkInfo'));
  }
  base.catalog.delete(PDFName.of('Outlines'));
  let dests = base.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  const offsets = fresh ? [] : [0];
  for (let k = fresh ? 0 : 1; k < parts.length; k++) {
    const src = parts[k]!.doc;
    const pdf = Boolean(parts[k]!.pdf);
    offsets.push(base.getPageCount());
    if (pdf) pinLinks(src);
    const srcPages = src.getPages();
    const copied = await base.copyPages(src, srcPages.map((_, i) => i));
    const map = new Map<string, PDFRef>();
    srcPages.forEach((p, i) => map.set(p.ref.toString(), copied[i]!.ref));
    for (const p of copied) base.addPage(p);
    if (pdf) unpinLinks(copied);
    // Internal links of a part printed by Chromium: rename their
    // destinations.
    const srcDests = pdf ? undefined : src.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
    if (srcDests) {
      if (!dests) {
        dests = ctx.obj({});
        base.catalog.set(PDFName.of('Dests'), ctx.register(dests));
      }
      const rename = (n: string) => `p${k}.${n}`;
      for (const [name, value] of srcDests.entries()) {
        const arr = value instanceof PDFRef ? src.context.lookup(value) : value;
        if (!(arr instanceof PDFArray)) continue;
        const target = arr.get(0);
        const mapped = target instanceof PDFRef ? map.get(target.toString()) : undefined;
        if (!mapped) continue;
        const copy = ctx.obj([mapped]);
        for (let i = 1; i < arr.size(); i++) copy.push(arr.get(i));
        dests.set(PDFName.of(rename(name.decodeText())), copy);
      }
      for (const p of copied) {
        const annots = p.node.Annots();
        if (!annots) continue;
        for (let i = 0; i < annots.size(); i++) {
          const a = annots.lookup(i, PDFDict);
          const d = a.get(PDFName.of('Dest'));
          if (d instanceof PDFName) a.set(PDFName.of('Dest'), PDFName.of(rename(d.decodeText())));
          else if (d instanceof PDFString || d instanceof PDFHexString) a.set(PDFName.of('Dest'), PDFName.of(rename(d.decodeText())));
        }
      }
    }
  }
  return { doc: base, pages: base.getPages(), offsets };
}

// wkhtmltopdf's Qt writes whole points: A4 is 595 x 842, not Chromium's
// 595.92 x 841.92.
export function setPageSize(pages: PDFPage[], widthPt: number, heightPt: number): void {
  const w = Math.round(widthPt);
  const h = Math.round(heightPt);
  for (const p of pages) {
    p.setMediaBox(0, 0, w, h);
    p.node.delete(PDFName.of('CropBox'));
  }
}

export interface FinalItem { title: string; dest: PDFArray; children: FinalItem[] }

// Writes the outline, the items of each part pointing at the merged pages.
export function writeOutline(doc: PDFDocument, items: FinalItem[]): void {
  if (!items.length) return;
  const ctx = doc.context;
  const rootRef = ctx.nextRef();
  const build = (list: FinalItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = list.length;
    list.forEach((item, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(item.title), Parent: parent, Dest: item.dest }) as PDFDict;
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]!);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]!);
      if (item.children.length) {
        const c = build(item.children, refs[i]!);
        dict.set(PDFName.of('First'), c.first);
        dict.set(PDFName.of('Last'), c.last);
        dict.set(PDFName.of('Count'), PDFNumber.of(c.count));
        count += c.count;
      }
      ctx.assign(refs[i]!, dict);
    });
    return { first: refs[0]!, last: refs[refs.length - 1]!, count };
  };
  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
}

// A destination of a part, pointing at the same place of the merged page.
export function moveDest(doc: PDFDocument, dest: PDFArray, page: PDFPage): PDFArray {
  const copy = doc.context.obj([page.ref]);
  for (let i = 1; i < dest.size(); i++) copy.push(dest.get(i));
  return copy;
}

// What becomes of a link: a destination makes it internal, a string is its
// new URI, null removes it, undefined leaves it.
export type LinkFate = PDFArray | PDFName | string | null | undefined;

// The link annotations, as `fate` decides from their URI (undefined for an
// internal link).
export function retargetLinks(pages: PDFPage[], fate: (uri: string | undefined) => LinkFate): void {
  for (const page of pages) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = annots.lookupMaybe(i, PDFDict);
      if (!annot || annot.lookup(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
      const action = annot.lookupMaybe(PDFName.of('A'), PDFDict);
      const uri = action?.lookup(PDFName.of('URI'));
      const isUri = uri instanceof PDFString || uri instanceof PDFHexString;
      if (action && !isUri && action.lookup(PDFName.of('S')) !== PDFName.of('GoTo')) continue;
      const f = fate(isUri ? uri.decodeText() : undefined);
      if (f === undefined) continue;
      if (f === null) annots.remove(i);
      else if (typeof f === 'string') action!.set(PDFName.of('URI'), PDFString.of(f));
      else {
        annot.delete(PDFName.of('A'));
        annot.set(PDFName.of('Dest'), f);
      }
    }
  }
}

// wkhtmltopdf prints --copies by repeating the pages: the whole document
// when collated, else each page. Its anchors are written again on each
// copy and the last ones win: links and outline go to the last copy. So
// the copies made here come first, and the pages that hold the
// destinations come last.
export function repeatPages(doc: PDFDocument, copies: number, collate: boolean): void {
  if (copies <= 1) return;
  const ctx = doc.context;
  const originals = doc.getPages();
  const copyOf = (page: PDFPage): PDFPage => {
    const node = page.node.clone(ctx);
    const ref = ctx.register(node);
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annots) {
      const list = ctx.obj([]);
      for (let i = 0; i < annots.size(); i++) {
        const a = annots.lookupMaybe(i, PDFDict);
        if (!a) continue;
        const c = a.clone(ctx);
        if (c.has(PDFName.of('P'))) c.set(PDFName.of('P'), ref);
        c.delete(PDFName.of('StructParent'));
        list.push(ctx.register(c));
      }
      node.set(PDFName.of('Annots'), list);
    }
    node.delete(PDFName.of('StructParents'));
    return PDFPage.of(node, ref, doc);
  };
  if (collate) {
    for (let c = 1; c < copies; c++) originals.forEach((p, i) => doc.insertPage((c - 1) * originals.length + i, copyOf(p)));
  } else {
    originals.forEach((p, i) => {
      for (let c = 1; c < copies; c++) doc.insertPage(i * copies + c - 1, copyOf(p));
    });
  }
}
