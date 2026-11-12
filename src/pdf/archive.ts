// PDF/A and Factur-X invoices, on both command lines: --pdfa and --factur-x
// called as pdfkiln, --kiln-pdfa and --kiln-factur-x called as wkhtmltopdf.
// Free under the MIT license since 1.3.0, like the rest of PDFKiln.
//
// Both work on the PDF once assembled, just before it is written: the file is
// loaded once, made PDF/A, given its invoice, and saved once. What the command
// line got wrong (a level PDFKiln does not write, an invoice it cannot read,
// an invoice with a level of part 2) is refused before Chromium starts, so a
// mistake costs no render. Loaded only when one of the options is there: a
// conversion without them reads none of this.
import { readFileSync } from 'node:fs';
import { PDFDocument } from '@cantoo/pdf-lib';
import { attachInvoice, readInvoice, type Invoice } from './facturx.js';
import { READ, WRITE } from './modules.js';
import { ArchiveError, applyPdfa, readLevel, type Level } from './pdfa.js';

export { ArchiveError };

// The options as the command line in use spells them, for its messages.
export interface Spelling {
  pdfa: string;
  facturX: string;
}

export const NATIVE: Spelling = { pdfa: '--pdfa', facturX: '--factur-x' };
export const COMPATIBLE: Spelling = { pdfa: '--kiln-pdfa', facturX: '--kiln-factur-x' };

export interface Request {
  // The PDF/A level the file gets.
  level: Level;
  // The invoice to attach, and what was read out of it.
  invoice?: { xml: Uint8Array; data: Invoice };
}

const words = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOENT' ? 'no such file' : code === 'EISDIR' ? 'a folder, not a file' : code === 'EACCES' ? 'permission denied' : (e as Error).message;
};

// What --pdfa and --factur-x ask for, read and checked: undefined when neither
// is there. `pdfa` is the option's value, empty for its default; `invoicePath`
// the file given to --factur-x. Throws an ArchiveError, its message naming the
// option.
export function archiveRequest(pdfa: string | undefined, invoicePath: string | undefined, spell: Spelling): Request | undefined {
  if (pdfa === undefined && invoicePath === undefined) return undefined;
  let level: Level | undefined;
  if (pdfa !== undefined) {
    try {
      level = readLevel(pdfa);
    } catch (e) {
      throw new ArchiveError(`${spell.pdfa}: ${(e as Error).message}`);
    }
  }
  if (invoicePath === undefined) return { level: level! };
  if (invoicePath === '') throw new ArchiveError(`${spell.facturX} needs the invoice's XML file`);
  let xml: Uint8Array;
  try {
    xml = readFileSync(invoicePath);
  } catch (e) {
    throw new ArchiveError(`${spell.facturX}: cannot read ${invoicePath}: ${words(e)}`);
  }
  let data: Invoice;
  try {
    data = readInvoice(xml);
  } catch (e) {
    throw new ArchiveError(`${spell.facturX}: ${(e as Error).message}`);
  }
  if (level && !level.startsWith('3')) {
    throw new ArchiveError(
      `${spell.facturX}: an invoice travels in PDF/A-3, and level ${level} is part 2, which allows no ` +
        `attached file. Ask ${spell.pdfa} for 3b or 3u, or leave it out`,
    );
  }
  return { level: level ?? '3b', invoice: { xml, data } };
}

// The PDF, made PDF/A, with its invoice when one was given. Throws an
// ArchiveError when the PDF cannot conform (a font not embedded, a font
// without a Unicode map at a u level).
export async function archive(pdf: Uint8Array, request: Request, spell: Spelling): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf, READ);
  try {
    applyPdfa(doc, request.level);
  } catch (e) {
    throw new ArchiveError(`${request.invoice ? spell.facturX : spell.pdfa}: ${(e as Error).message}`);
  }
  if (request.invoice) await attachInvoice(doc, request.invoice.xml, request.invoice.data);
  return doc.save(WRITE);
}
