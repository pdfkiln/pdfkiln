// Factur-X and ZUGFeRD invoices: --factur-x on the native command line,
// --kiln-factur-x on the compatible one (src/pdf/archive.ts).
//
// A Factur-X invoice is a PDF/A-3 carrying the invoice as CII XML, so most of
// the work is done by pdfa.ts and by pdf-lib's embedFacturX, which attaches the
// file and writes the fx: properties and the PDF/A extension schema. What is
// left, and what this file does, is to read the XML we are handed: its
// profile, so that the XMP cannot disagree with the invoice, and the three
// fields every profile requires, so that a truncated file or an invoice in
// another format is caught here rather than at the recipient's platform.
//
// It does not check the EN 16931 business rules: they ship as Schematron
// compiled to XSLT 2.0, which Node does not run, and claiming them without
// running them would be worse than saying so. PDFKiln attaches the invoice it
// is given; it does not write it.
import { AFRelationship, embedFacturX, type FacturXConformanceLevel, type PDFDocument } from '@cantoo/pdf-lib';
import sax from 'sax';
import { ArchiveError } from './pdfa.js';

// The namespace of a Cross Industry Invoice, whatever the profile.
const CII_NAMESPACE = 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100';

// A profile, recognised from a token of its URN rather than from the whole
// string: Factur-X 1.0.x, ZUGFeRD 2.0 to 2.3 and XRechnung all write their own
// version into it, and a new minor version must not stop working.
const PROFILE_TOKENS: [RegExp, FacturXConformanceLevel][] = [
  [/:minimum\b/i, 'MINIMUM'],
  [/:basicwl\b/i, 'BASIC WL'],
  [/:basic\b/i, 'BASIC'],
  [/:extended\b/i, 'EXTENDED'],
  [/xrechnung/i, 'XRECHNUNG'],
  // The bare EN 16931 URN is the comfort profile; it comes last, since every
  // compliant profile above quotes it as well.
  [/^urn:cen\.eu:en16931:2017/i, 'EN 16931'],
];

// What is read out of the XML, and nothing more.
export interface Invoice {
  // The profile URN as the file declares it (BT-24).
  urn: string;
  // The profile, as the XMP must advertise it.
  profile: FacturXConformanceLevel;
  // The invoice number (BT-1).
  number: string;
  // The issue date as written, YYYYMMDD in format 102 (BT-2).
  issueDate: string;
  // The document type code: 380 for an invoice, 381 for a credit note (BT-3).
  typeCode: string;
}

// How the file travels, by profile (Factur-X 1.07.2, section 6.2.2; ZUGFeRD
// 2.1 and later). The XML of MINIMUM and BASIC WL holds only part of what the
// page shows, not the invoice again: its relationship is Data. The others may
// say Alternative, the XML and the page being the same invoice. XRECHNUNG's
// file has a name of its own.
export function embedding(profile: FacturXConformanceLevel): { fileName: string; afRelationship: AFRelationship } {
  return {
    fileName: profile === 'XRECHNUNG' ? 'xrechnung.xml' : 'factur-x.xml',
    afRelationship: profile === 'MINIMUM' || profile === 'BASIC WL' ? AFRelationship.Data : AFRelationship.Alternative,
  };
}

// The path of the open elements, as local>local>local.
const pathOf = (stack: string[]): string => stack.join('>');

// Read the invoice. Strict, streaming, namespace-aware, and with no entity of
// any kind: an invoice needs none, and a DOCTYPE in a file from outside is
// either a mistake or an attack.
export function readInvoice(xml: Uint8Array): Invoice {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(xml);
  const parser = sax.parser(true, { xmlns: true, position: true });
  const stack: string[] = [];
  const wanted: Record<string, keyof Invoice> = {
    'CrossIndustryInvoice>ExchangedDocumentContext>GuidelineSpecifiedDocumentContextParameter>ID': 'urn',
    'CrossIndustryInvoice>ExchangedDocument>ID': 'number',
    'CrossIndustryInvoice>ExchangedDocument>TypeCode': 'typeCode',
    'CrossIndustryInvoice>ExchangedDocument>IssueDateTime>DateTimeString': 'issueDate',
  };
  const found: Partial<Record<keyof Invoice, string>> = {};
  let collecting: keyof Invoice | undefined;
  let root: { local: string; uri: string } | undefined;
  let failure: string | undefined;

  parser.onerror = (err: Error): void => {
    failure ??= err.message.split('\n')[0] ?? err.message;
  };
  parser.ondoctype = (): void => {
    failure ??= 'it declares a DOCTYPE, which an invoice has no use for';
  };
  parser.onopentag = (tag): void => {
    const node = tag as { local?: string; uri?: string; name: string };
    const local = node.local ?? node.name;
    stack.push(local);
    root ??= { local, uri: node.uri ?? '' };
    collecting = wanted[pathOf(stack)];
    if (collecting && found[collecting] === undefined) found[collecting] = '';
  };
  parser.ontext = (chunk: string): void => {
    if (collecting) found[collecting] = (found[collecting] ?? '') + chunk;
  };
  parser.onclosetag = (): void => {
    stack.pop();
    collecting = undefined;
  };
  try {
    parser.write(text).close();
  } catch (err) {
    // In strict mode sax throws on the write that follows an error it has
    // already reported; the first reason is the one worth saying.
    failure ??= (err as Error).message.split('\n')[0];
  }

  if (failure) throw new ArchiveError(`the XML cannot be read: ${failure}`);
  if (!root || root.local !== 'CrossIndustryInvoice') {
    throw new ArchiveError(
      `this is not a Cross Industry Invoice. Its root element is <${root?.local ?? 'nothing'}>, and Factur-X and ` +
        'ZUGFeRD both carry <rsm:CrossIndustryInvoice>. A UBL invoice is a different format',
    );
  }
  if (root.uri && root.uri !== CII_NAMESPACE) {
    throw new ArchiveError(`the root element is in the namespace "${root.uri}", and a Cross Industry Invoice is in "${CII_NAMESPACE}"`);
  }
  const urn = (found.urn ?? '').trim();
  if (!urn) {
    throw new ArchiveError(
      'the XML declares no profile. Factur-X and ZUGFeRD both carry it in ' +
        'ExchangedDocumentContext/GuidelineSpecifiedDocumentContextParameter/ID (BT-24)',
    );
  }
  const profile = PROFILE_TOKENS.find(([token]) => token.test(urn))?.[1];
  if (!profile) {
    throw new ArchiveError(`the profile "${urn}" is not one PDFKiln knows. It writes MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED and XRECHNUNG`);
  }
  const missing = (['number', 'typeCode', 'issueDate'] as const).filter((k) => !found[k]?.trim());
  if (missing.length > 0) {
    const names = { number: 'the invoice number (BT-1)', typeCode: 'the type code (BT-3)', issueDate: 'the issue date (BT-2)' };
    throw new ArchiveError(`the invoice is missing ${missing.map((k) => names[k]).join(' and ')}, which every profile requires`);
  }
  const issueDate = found.issueDate!.trim();
  if (!/^\d{8}$/.test(issueDate) || Number.isNaN(Date.parse(`${issueDate.slice(0, 4)}-${issueDate.slice(4, 6)}-${issueDate.slice(6)}T00:00:00Z`))) {
    throw new ArchiveError(`the issue date "${issueDate}" is not a date in format 102 (YYYYMMDD)`);
  }
  return { urn, profile, number: found.number!.trim(), issueDate, typeCode: found.typeCode!.trim() };
}

// Attach the invoice to a document already made PDF/A-3 (applyPdfa): the XML
// as an associated file, named and related as its profile requires, and the
// profile in the XMP. embedFacturX would convert on its own, but then the
// checks of applyPdfa would not run, and a file labelled PDF/A-3 that is not
// one is exactly what the recipient's platform rejects.
export async function attachInvoice(doc: PDFDocument, xml: Uint8Array, invoice: Invoice): Promise<void> {
  await embedFacturX(doc, xml, { conformanceLevel: invoice.profile, ...embedding(invoice.profile) });
}
