// PDF/A for archiving: --pdfa, on the native command line (src/pdf/archive.ts).
//
// The hard part was never the metadata: it was whether Chromium's output can
// conform at all. Measured over the compatibility corpus on 11 November 2026
// with veraPDF 1.30.4: 29 files of 29 valid at 2b, 2u, 3b and 3u, every font
// embedded and carrying a ToUnicode map; none at 1b. pdf-lib, which assembles
// the PDF, writes the output intent, the sRGB profile and the XMP; this file
// picks the level, refuses what cannot conform, and leaves the writing to it.
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream } from '@cantoo/pdf-lib';

// What the user asked for and cannot have, as opposed to what broke: the
// command prints the message as it stands, and exits 1.
export class ArchiveError extends Error {}

// The levels PDFKiln writes, and what pdf-lib calls them.
export const LEVELS = { '2b': '2B', '2u': '2U', '3b': '3B', '3u': '3U' } as const;

export type Level = keyof typeof LEVELS;

// What a bare --pdfa means: the part Factur-X needs, at the level that asks
// nothing of the document's text.
export const DEFAULT_LEVEL: Level = '3b';

const LEVEL_LIST = Object.keys(LEVELS).join(', ');

// Why a level of the standard is not on offer, rather than "no such level".
// PDF/A-1 forbids transparency, and Chromium draws with it: every file of the
// corpus failed 1b, all 29 for a missing CIDSet and 18 for a `ca` below 1.0 or
// an SMask. A converter can reach it by flattening the transparency into
// images, which is not what anyone asking for an archive of a page wants from
// PDFKiln. Level A needs a fully tagged document, which no browser print is.
const OUT_OF_REACH: Record<string, string> = {
  '1b': 'PDF/A-1 forbids transparency, which Chromium draws with, and PDFKiln does not flatten it into images',
  '1a': 'level A needs a fully tagged document, which a browser print is not',
  '2a': 'level A needs a fully tagged document, which a browser print is not',
  '3a': 'level A needs a fully tagged document, which a browser print is not',
};

// The level of a --pdfa value: empty for the default. Throws for a level
// PDFKiln does not write.
export function readLevel(value: string): Level {
  const level = value.trim().toLowerCase();
  if (level === '') return DEFAULT_LEVEL;
  if (level in LEVELS) return level as Level;
  const why = OUT_OF_REACH[level];
  throw new ArchiveError(
    why ? `${why}. PDFKiln writes ${LEVEL_LIST}` : `no such level "${value}". PDFKiln writes ${LEVEL_LIST}`,
  );
}

// A font's name as the file gives it, without a subset tag.
function fontName(font: PDFDict): string {
  const base = font.lookupMaybe(PDFName.of('BaseFont'), PDFName);
  if (!base) return '(unnamed font)';
  return String(base).replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
}

// Every font dictionary the pages reach, pages and form XObjects alike.
function fontDicts(doc: PDFDocument): PDFDict[] {
  const fonts: PDFDict[] = [];
  const seen = new Set<unknown>();
  const walk = (resources: PDFDict | undefined): void => {
    if (!resources) return;
    const table = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
    if (table) {
      for (const [, value] of table.entries()) {
        if (seen.has(value)) continue;
        seen.add(value);
        const font = doc.context.lookupMaybe(value, PDFDict);
        if (font) fonts.push(font);
      }
    }
    // A form XObject carries its own resources, and its own fonts with them.
    const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xobjects) {
      for (const [, value] of xobjects.entries()) {
        if (seen.has(value)) continue;
        seen.add(value);
        const stream = doc.context.lookupMaybe(value, PDFStream);
        if (stream) walk(stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict));
      }
    }
  };
  for (const page of doc.getPages()) walk(page.node.Resources());
  return fonts;
}

// Whether a font's glyphs travel with the file.
function embedded(doc: PDFDocument, font: PDFDict): boolean {
  // A Type3 font draws its glyphs with content streams of its own (CharProcs):
  // embedded by definition, and veraPDF accepts it.
  if (String(font.lookupMaybe(PDFName.of('Subtype'), PDFName)) === '/Type3') return true;
  const descriptors: PDFDict[] = [];
  const own = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  if (own) descriptors.push(own);
  // A composite font keeps its descriptor one level down, in DescendantFonts.
  const kids = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray);
  for (let i = 0; kids && i < kids.size(); i++) {
    const fd = doc.context.lookupMaybe(kids.get(i), PDFDict)?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    if (fd) descriptors.push(fd);
  }
  // No descriptor at all is one of the 14 standard fonts: the bytes are the
  // reader's, and PDF/A has no reader to lean on.
  if (descriptors.length === 0) return false;
  return descriptors.every((fd) => ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.get(PDFName.of(k)) !== undefined));
}

// Every font the document names whose bytes are missing. PDF/A allows none,
// at any level: a reader that substitutes a font has already lost the page.
export function fontsNotEmbedded(doc: PDFDocument): string[] {
  return [...new Set(fontDicts(doc).filter((font) => !embedded(doc, font)).map(fontName))].sort();
}

// Every font with no ToUnicode map. The u levels promise that the text can be
// extracted, and pdf-lib writes the level without checking it: this is all
// that stands between a 3u label and a file that is not one. Measured: no
// font of the corpus lacks it.
export function fontsNotMappedToUnicode(doc: PDFDocument): string[] {
  return [...new Set(fontDicts(doc).filter((font) => font.get(PDFName.of('ToUnicode')) === undefined).map(fontName))].sort();
}

const list = (names: string[]): string => names.join(', ');

// Turn a loaded document into PDF/A, in place, so that an invoice can be
// attached to the same one and the file written once. It refuses rather than
// hand back a file labelled PDF/A that is not one: whoever asked has
// something downstream that validates.
export function applyPdfa(doc: PDFDocument, level: Level): void {
  const unembedded = fontsNotEmbedded(doc);
  if (unembedded.length > 0) {
    throw new ArchiveError(
      `${unembedded.length === 1 ? 'a font is' : 'fonts are'} not embedded in the PDF (${list(unembedded)}), ` +
        `and PDF/A-${level} requires every font to be. Install the font where PDFKiln renders, or name one it can embed`,
    );
  }
  if (level.endsWith('u')) {
    const unmapped = fontsNotMappedToUnicode(doc);
    if (unmapped.length > 0) {
      throw new ArchiveError(
        `${list(unmapped)} ${unmapped.length === 1 ? 'has' : 'have'} no Unicode map, and PDF/A-${level} requires ` +
          `the text to be extractable. Level ${level[0]}b does not`,
      );
    }
  }
  doc.convertToPDFA({ conformance: LEVELS[level] });
}

// The PDF/A a PDF declares in its XMP (pdfaid:part, pdfaid:conformance, as
// elements or as attributes), null for none.
export function declaredPdfa(doc: PDFDocument): { part: number; conformance: string } | null {
  const meta = doc.catalog.lookupMaybe(PDFName.of('Metadata'), PDFStream);
  if (!(meta instanceof PDFRawStream)) return null;
  let xmp: string;
  try {
    xmp = Buffer.from(meta.dict.has(PDFName.of('Filter')) ? decodePDFRawStream(meta).decode() : meta.contents).toString('utf8');
  } catch {
    return null;
  }
  const value = (name: string) => new RegExp(`pdfaid:${name}\\s*=\\s*["']([^"']*)["']|<pdfaid:${name}>\\s*([^<]*?)\\s*<`).exec(xmp)?.slice(1).find((v) => v !== undefined);
  const part = Number(value('part'));
  return part >= 1 && part <= 4 ? { part, conformance: (value('conformance') ?? '').toUpperCase() } : null;
}

// The number of colour components of a PDF's output intents: 3 for RGB, 4
// for CMYK, 1 for grey; none without one.
function intentComponents(doc: PDFDocument): number[] {
  const intents = doc.catalog.lookupMaybe(PDFName.of('OutputIntents'), PDFArray);
  const found: number[] = [];
  for (let i = 0; intents && i < intents.size(); i++) {
    const profile = intents.lookupMaybe(i, PDFDict)?.lookupMaybe(PDFName.of('DestOutputProfile'), PDFStream);
    const n = profile?.dict.lookupMaybe(PDFName.of('N'), PDFNumber)?.asNumber();
    if (n !== undefined) found.push(n);
  }
  return found;
}

// A file attached to a page of a PDF: a FileAttachment annotation, or the
// associated files (/AF) of the page or of an annotation, which PDF/A-3
// allows and PDF/A-2 forbids. Those of the catalog, a Factur-X invoice's
// among them, stay out of the merge.
function attachedToPages(doc: PDFDocument): boolean {
  for (const page of doc.getPages()) {
    if (page.node.has(PDFName.of('AF'))) return true;
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    for (let i = 0; annots && i < annots.size(); i++) {
      const a = annots.lookupMaybe(i, PDFDict);
      if (a && (a.lookup(PDFName.of('Subtype')) === PDFName.of('FileAttachment') || a.has(PDFName.of('AF')))) return true;
    }
  }
  return false;
}

// Why a PDF made elsewhere, one of the inputs, may not go into a PDF/A at
// this level, or '' when it may. PDFKiln checks the fonts and nothing else
// of a page (applyPdfa), which holds for what Chromium prints and not for a
// PDF from anywhere: such a PDF must already be PDF/A, as it declares, and
// its colours for the screen (sRGB, the output intent PDFKiln writes).
// Measured with veraPDF 1.30 on 19 November 2026: PDF/A of LibreOffice 26.2
// (1b, 2b, 3b, with images, links and bookmarks), Ghostscript 10.05 (2b)
// and PDFKiln (2b, 3u, Factur-X), merged before or after a page at 2b, 2u,
// 3b, 3u and as Factur-X: 42 files of 42 valid, PDF/A-3 inputs at 2b and 2u
// among them, their attachments being the catalog's. Forced past this check,
// a LibreOffice PDF that is not PDF/A fails (6.3.2-1, a font), and a PDF/A
// for print in CMYK fails (6.2.4.3-3, DeviceCMYK under an sRGB intent).
export function archivable(doc: PDFDocument, level: Level): string {
  const declared = declaredPdfa(doc);
  if (!declared) {
    return 'is not PDF/A, and PDFKiln cannot check that a PDF made elsewhere conforms: export it as PDF/A where it is made (PDF/A-2b or 3b)';
  }
  if (declared.part === 4) return 'is PDF/A-4, built on PDF 2.0, which PDFKiln does not write: export it as PDF/A-2b or 3b';
  if (declared.part > Number(level[0]) && attachedToPages(doc)) {
    return `is PDF/A-3 with a file attached to its pages, which PDF/A-${level[0]} forbids: ask --pdfa for 3b or 3u`;
  }
  const print = intentComponents(doc).find((n) => n !== 3);
  if (print !== undefined) {
    return `is PDF/A for ${print === 4 ? 'print, in CMYK' : 'other colours than RGB'}, and the PDF/A PDFKiln writes is in sRGB: export it for the screen (RGB)`;
  }
  return '';
}
