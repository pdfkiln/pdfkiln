// PDF/A for archiving: --pdfa on the native command line, --kiln-pdfa on the
// compatible one (src/pdf/archive.ts).
//
// The hard part was never the metadata: it was whether Chromium's output can
// conform at all. Measured over the compatibility corpus on 11 November 2026
// with veraPDF 1.30.4: 29 files of 29 valid at 2b, 2u, 3b and 3u, every font
// embedded and carrying a ToUnicode map; none at 1b. pdf-lib, which assembles
// the PDF, writes the output intent, the sRGB profile and the XMP; this file
// picks the level, refuses what cannot conform, and leaves the writing to it.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from '@cantoo/pdf-lib';

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
