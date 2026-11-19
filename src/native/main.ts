// The native interface, called as pdfkiln: Chromium's own rendering, with
// modern defaults:
// - pdfkiln <input>... <output>: files, URLs (http:, https:, file:, data:)
//   or - (standard input), merged in order; - as output is the standard
//   output;
// - print media; paper size and margins from the page's @page rule (A4 and
//   1 cm otherwise), headers and footers from its @page margin boxes;
//   --css adds a style sheet after the page's own, --media screen renders
//   it as on screen;
// - --header and --cookie go with the requests to the input's host, and
//   to no other; --wait-for waits for an element before the delay;
// - --tagged keeps the structure tree; --outline adds bookmarks;
// - the JavaScript delay of the compatible mode, cut short once nothing
//   can change the page, 1000 ms at most by default;
// - secure by default: a page reads no local file but itself unless --allow
//   or --enable-local-file-access, reaches no loopback, private or
//   link-local address unless --allow-private-network, and loads nothing
//   from a server whose certificate does not verify unless
//   --allow-invalid-certificates;
// - an input that does not load fails: exit 1, no PDF; with
//   --fail-on-resource-error, so does an input one of whose resources does
//   not;
// - its own messages, with why: one error for an input that does not load,
//   a warning for each resource that does not (-q hides them), or with
//   --fail-on-resource-error an error for each, once the input has loaded
//   and printed;
// - --title, --author, --subject and --keywords: the PDF's properties, the
//   title being the page's otherwise;
// - Markdown, from a file or an http(s) URL named .md or .markdown, or with
//   --from markdown (a URL fetched here, with the checks of the relay):
//   GitHub's dialect and math, printed with pdfkiln's style sheet
//   (src/markdown/), without JavaScript; its images may come from the
//   document's folder (from the web for a URL), and its front matter gives
//   the properties that no option does;
// - an image instead of a PDF, for an output named .png, .webp, .jpg or
//   .jpeg, or with --to: one input captured in screen media
//   (src/native/image.ts);
// - PDFs made elsewhere among the inputs, a file or an http(s) URL named
//   .pdf: their pages go in as they are, their links and bookmarks kept;
//   Chromium does not start when every input is a PDF file;
// - --user-password, --owner-password, --no-print, --no-copy and
//   --no-modify: the PDF encrypted with AES-256, what it asks of whoever
//   opens it.
import { mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, posix, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { PDFDocument } from '@cantoo/pdf-lib';
import type { Page } from 'puppeteer-core';
import { deadline, launch, LaunchError, removeQuietly, type Session } from '../engine/browser.js';
import { filePath } from '../engine/files.js';
import { markFrames, printApart, printer } from '../engine/frames.js';
import { openPage, type Failure, type Reporter } from '../engine/loader.js';
import { BlockedAddress, CertificateError, relayRequest, startRelay, type Relay } from '../engine/relay.js';
import type { FrontMatter } from '../markdown/frontmatter.js';
import { MARGIN_LEFT_CM, MARGIN_TOP_CM } from '../markdown/style.js';
import type { Request as ArchiveRequest } from '../pdf/archive.js';
import type { FinalItem, OutlineItem } from '../pdf/assemble.js';
import { pdfModules, READ, WRITE } from '../pdf/modules.js';
import { chromiumVersion, version } from '../version.js';
import { defaultObject } from '../wk/settings.js';
import { capture, DEFAULT_HEIGHT, DEFAULT_WIDTH, formatOfTo, imageFormatOf, type ImageFormat } from './image.js';

const HELP = `PDFKiln: HTML and Markdown to PDF and images with Chromium

Usage:
  pdfkiln [options] <input>... <output>
  pdfkiln <command> [options]

Examples:
  pdfkiln invoice.html invoice.pdf
  pdfkiln https://example.com/report report.pdf
  pdfkiln cover.html body.html book.pdf     # merged in order
  pdfkiln - - < page.html > page.pdf        # standard input and output
  pdfkiln notes.md notes.pdf                # Markdown
  pdfkiln invoice.html terms.pdf out.pdf    # a PDF after the page
  pdfkiln --factur-x invoice.xml invoice.html invoice.pdf
  pdfkiln https://example.com page.png      # an image: PNG, WebP or JPEG

Inputs are files, URLs (http:, https:, file:, data:) or - for the standard
input; the output is a file, or - for the standard output. Paper size,
margins, headers and footers come from the page's CSS (@page and its margin
boxes): A4 with 1 cm margins otherwise.

Files and http(s) URLs named .md or .markdown are Markdown: GitHub's
dialect, with math ($...$, $$...$$) and a front matter, printed with
PDFKiln's style sheet, without JavaScript. Its images may come from the
document's folder, or for a URL from the web.

Files and http(s) URLs named .pdf are PDFs made elsewhere: their pages go
in as they are, with their links. They make a PDF, not an image; with
--pdfa or --factur-x, they must be PDF/A themselves.

An output named .png, .webp, .jpg or .jpeg is an image of one input, in
screen media: the whole page, in a window 1280 pixels wide.

Rendering:
  --from markdown             Read every input but PDFs as Markdown,
                              whatever its name (README, notes.txt, a URL,
                              the standard input)
  --css <file>                Add a style sheet after the page's own
  --media <print|screen>      CSS media type (default: print; screen for an
                              image)

PDF:
  --outline                   Bookmarks from the headings (and a PDF input's)
  --tagged                    Tagged PDF, for screen readers (one HTML or
                              Markdown input)

Document properties (default: from the front matter of Markdown):
  --title <text>              Title (default: the page's <title>)
  --author <text>             Author
  --subject <text>            Subject
  --keywords <text>           Keywords

PDF/A and electronic invoices:
  --pdfa[=<level>]            PDF/A for archiving: 2b, 2u, 3b, 3u (default: 3b)
  --factur-x <invoice.xml>    Attach the invoice's CII XML: a Factur-X or
                              ZUGFeRD invoice, in PDF/A-3

Passwords (AES-256, not with --pdfa or --factur-x):
  --user-password <text>      Password to open the PDF
  --owner-password <text>     Password with every right; the restrictions
                              below bind anyone who opens the PDF without it
  --no-print                  No printing
  --no-copy                   No copying of text and images (screen readers
                              still read them)
  --no-modify                 No changes to content, notes, forms or pages

Images:
  --to <png|webp|jpeg|pdf>    Format of the output, whatever its name (the
                              standard output is a PDF without it)
  --width <px>                Window width (default: 1280)
  --height <px>               Window height, and an image of the window only
                              (default: 720, and an image of the whole page)
  --element <selector>        Only the first element matching this selector
  --scale <factor>            Pixels per CSS pixel (default: 1; 2 for sharp
                              images on high-density screens)
  --quality <1-100>           JPEG and WebP quality (default: 90 for JPEG,
                              lossless WebP)
  --transparent               No white behind a page without a background
                              (PNG and WebP)

Waiting for the page:
  --javascript-delay <ms>     Wait up to this long after loading, less once
                              the page stops changing (default: 1000; 0: none)
  --wait-for <selector>       First wait for an element matching this selector
  --timeout <seconds>         Give up after this long (default: 120; 0: none)

Requests to the input's host, and no other (repeatable):
  --header "<name>: <value>"  Send this HTTP header
  --cookie <name>=<value>     Send this cookie

Access, refused by default:
  --allow <path>              Let local pages read files under this path
                              (repeatable)
  --enable-local-file-access  Let local pages read any local file
  --allow-private-network     Let pages reach localhost, private and
                              link-local addresses
  --allow-invalid-certificates
                              Let pages load from servers whose certificate
                              does not verify (self-signed, expired, issued
                              for another name)

Other:
  --fail-on-resource-error    Fail, without a PDF, when an image, font, style
                              sheet or other resource does not load
  -q, --quiet                 No warnings
  --no-sandbox                Run Chromium without its sandbox (not advised)
  -V, --version               Show the version
  -h, --help                  Show this help

Commands:
  wkhtmltopdf                 The command line of wkhtmltopdf 0.12.6
  wkhtmltoimage               The command line of wkhtmltoimage 0.12.6
  "pdfkiln <command> --help" shows the options of each.

Exit code: 0 once the output is written, 1 otherwise, with the reason.
Docs: https://pdfkiln.org
`;

const stderr = (s: string) => writeSync(2, s);
// The 1 cm margins in points; an @page margin of the page moves its
// internal links' targets by the difference.
const CM_PT = 72 / 2.54;
const PT_PER_PX = 72 / 96;

// An input is a URL when it says so, a file otherwise: a missing file is
// not looked for on the web, as wkhtmltopdf's guess did (report.html as
// http://report.html/).
const URL_INPUT = /^(https?|file|data):/i;

// A Markdown file; with --from markdown, every input. No --from html: Chromium
// reads a file by its name, and takes a .md one for a download.
const MARKDOWN_NAME = /\.(md|markdown)$/i;

// A PDF made elsewhere, by its name.
const PDF_NAME = /\.pdf$/i;

// The bytes of a PDF: its header within its first kilobyte, as readers
// accept it.
const isPdfData = (b: Buffer): boolean => b.subarray(0, 1024).includes('%PDF-');

// A PDF input, read; the reason otherwise. An encrypted one is refused:
// PDFKiln does not lift a password or restrictions.
async function readPdf(lib: typeof import('@cantoo/pdf-lib'), bytes: Buffer): Promise<PDFDocument | string> {
  if (!isPdfData(bytes)) return 'not a PDF';
  let doc: PDFDocument;
  try {
    doc = await lib.PDFDocument.load(bytes, READ);
  } catch (e) {
    if (e instanceof lib.EncryptedPDFError) return 'the PDF is encrypted, and PDFKiln does not remove its password or restrictions';
    return `not a readable PDF (${(e as Error).message})`;
  }
  return doc.getPageCount() ? doc : 'the PDF has no page';
}

// --timeout when Chromium does not run: every input a PDF file.
function timer(seconds: number, onTimeout: () => void): () => void {
  if (!seconds || seconds * 1000 > 2 ** 31 - 1) return () => {};
  const t = setTimeout(onTimeout, seconds * 1000);
  t.unref();
  return () => clearTimeout(t);
}

// The Markdown renderer, loaded on demand like pdf-lib (src/pdf/modules.ts):
// while Chromium starts, and only when an input is Markdown.
let markdownLoading: Promise<typeof import('../markdown/render.js')> | undefined;
const markdownModule = () => (markdownLoading ??= import('../markdown/render.js'));

// What keeps a file from being an input: missing, or not a file. A missing
// one named like a host (www.example.com, localhost:8080/page, 10.0.0.5),
// not like a page (report.html), was meant as a URL.
function notAFile(input: string, url: string): string {
  if (!url.startsWith('file:')) return '';
  const path = filePath(url);
  const st = path ? statSync(path, { throwIfNoEntry: false }) : undefined;
  if (st) return st.isFile() ? '' : 'not a file';
  const host = /^([^/\\:]+)(:\d+)?(\/|$)/.exec(input)?.[1] ?? '';
  const page = /\.(x?html?|xml|svg|txt|pdf|json|css|js|md|markdown)$/i.test(host);
  const hostLike = host === 'localhost' || isIP(host) === 4 || (!page && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(host));
  return hostLike ? 'no such file (a URL starts with https://)' : 'no such file';
}

// The usual failures in words; the others as Chromium (net::ERR_…) or the
// system (EPROTO…) names them.
const WORDS: Record<string, string> = {
  'net::ERR_NAME_NOT_RESOLVED': 'host not found',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host not found',
  'net::ERR_CONNECTION_REFUSED': 'connection refused',
  ECONNREFUSED: 'connection refused',
  'net::ERR_CONNECTION_TIMED_OUT': 'timed out',
  'net::ERR_TIMED_OUT': 'timed out',
  ETIMEDOUT: 'timed out',
  'net::ERR_CONNECTION_RESET': 'connection closed',
  'net::ERR_CONNECTION_CLOSED': 'connection closed',
  'net::ERR_EMPTY_RESPONSE': 'connection closed',
  // Windows, for a server that closes as soon as it accepts.
  'net::ERR_CONNECTION_ABORTED': 'connection closed',
  'net::ERR_SOCKET_NOT_CONNECTED': 'connection closed',
  ECONNRESET: 'connection closed',
  'net::ERR_ADDRESS_UNREACHABLE': 'host unreachable',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'host unreachable',
  'net::ERR_FILE_NOT_FOUND': 'no such file',
  'net::ERR_ACCESS_DENIED': 'not an allowed file (--allow <path> or --enable-local-file-access to read it)',
};

// A URL's name decoded, as written when it cannot be.
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function words(name: string): string {
  if (name.startsWith('net::ERR_CERT_')) return `invalid certificate (${name})`;
  if (/^(net::)?ERR_SSL_|^EPROTO$/.test(name)) return `TLS error (${name})`;
  return WORDS[name] ?? name;
}

function writeAll(fd: number, data: Uint8Array): void {
  for (let off = 0; off < data.length;) off += writeSync(fd, data, off);
}

// The PDF or the image, to its file or to the standard output.
function writeOutput(output: string, data: Uint8Array): void {
  if (output === '-') writeAll(1, data);
  else writeFileSync(output, data);
}

// The text of the page's headings, as rendered and as written; none if the
// page does not answer, which leaves Chromium's titles as they are.
function headingTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'), (h) => [(h as HTMLElement).innerText, h.textContent ?? '']).flat())
    .catch(() => []);
}

// PDFKILN_TIMINGS=1 writes the time of each step, in ms, on stderr, as the
// compatible mode does; the steps of several inputs add up.
const timings: Record<string, number> = {};
let mark = 0;
const step = (name: string) => {
  const now = performance.now();
  timings[name] = (timings[name] ?? 0) + Math.round(now - mark);
  mark = now;
};

export async function nativeMain(args: string[]): Promise<number> {
  mark = performance.now();
  timings.boot = Math.round(mark);
  let parsed;
  try {
    parsed = parseArgs({
      // A bare --pdfa asks for the default level: parseArgs has no optional
      // value, and would take the next argument, an input, for the level.
      args: args.map((a) => (a === '--pdfa' ? '--pdfa=' : a)),
      allowPositionals: true,
      options: {
        tagged: { type: 'boolean' },
        outline: { type: 'boolean' },
        from: { type: 'string' },
        css: { type: 'string' },
        media: { type: 'string' },
        'javascript-delay': { type: 'string' },
        'wait-for': { type: 'string' },
        header: { type: 'string', multiple: true },
        cookie: { type: 'string', multiple: true },
        allow: { type: 'string', multiple: true },
        'enable-local-file-access': { type: 'boolean' },
        'allow-private-network': { type: 'boolean' },
        'allow-invalid-certificates': { type: 'boolean' },
        timeout: { type: 'string' },
        'fail-on-resource-error': { type: 'boolean' },
        title: { type: 'string' },
        author: { type: 'string' },
        subject: { type: 'string' },
        keywords: { type: 'string' },
        pdfa: { type: 'string' },
        'factur-x': { type: 'string' },
        to: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        element: { type: 'string' },
        scale: { type: 'string' },
        quality: { type: 'string' },
        transparent: { type: 'boolean' },
        'user-password': { type: 'string' },
        'owner-password': { type: 'string' },
        'no-print': { type: 'boolean' },
        'no-copy': { type: 'boolean' },
        'no-modify': { type: 'boolean' },
        'no-sandbox': { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        version: { type: 'boolean', short: 'V' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    stderr(`pdfkiln: ${(e as Error).message}\n\n${HELP}`);
    return 1;
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    writeSync(1, HELP);
    return 0;
  }
  if (v.version) {
    writeSync(1, `PDFKiln ${version}, Chromium ${chromiumVersion}\n`);
    return 0;
  }
  if (positionals.length < 2) {
    stderr(`pdfkiln: give at least one input and the output\n\n${HELP}`);
    return 1;
  }
  const timeout = v.timeout === undefined ? 120 : Number(v.timeout);
  if (!Number.isFinite(timeout) || timeout < 0) {
    stderr(`pdfkiln: --timeout takes a number of seconds\n`);
    return 1;
  }
  const jsdelay = v['javascript-delay'] === undefined ? 1000 : Number(v['javascript-delay']);
  if (!Number.isInteger(jsdelay) || jsdelay < 0) {
    stderr(`pdfkiln: --javascript-delay takes a number of milliseconds\n`);
    return 1;
  }
  const inputs = positionals.slice(0, -1);
  const output = positionals[positionals.length - 1]!;
  // An image, by --to or by the output's name; a PDF otherwise. Each kind
  // refuses the other's options: a mistake costs no render.
  let image: ImageFormat | null;
  if (v.to !== undefined) {
    const to = formatOfTo(v.to);
    if (to === undefined) {
      stderr('pdfkiln: --to takes png, webp, jpeg or pdf\n');
      return 1;
    }
    image = to;
  } else image = imageFormatOf(output);
  const pdfOnly = ['outline', 'tagged', 'title', 'author', 'subject', 'keywords', 'pdfa', 'factur-x', 'user-password', 'owner-password', 'no-print', 'no-copy', 'no-modify'] as const;
  const imageOnly = ['width', 'height', 'element', 'scale', 'quality', 'transparent'] as const;
  for (const name of image ? pdfOnly : imageOnly) {
    if (v[name] !== undefined) {
      stderr(image
        ? `pdfkiln: --${name} is for a PDF, not an image\n`
        : `pdfkiln: --${name} is for an image: an output named .png, .webp, .jpg or .jpeg, or --to\n`);
      return 1;
    }
  }
  const pixels = (name: string, value: string | undefined): number | null | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1) return n;
    stderr(`pdfkiln: --${name} takes a number of pixels\n`);
    return null;
  };
  const width = pixels('width', v.width);
  const height = pixels('height', v.height);
  if (width === null || height === null) return 1;
  const scale = v.scale === undefined ? 1 : Number(v.scale);
  if (!Number.isFinite(scale) || scale <= 0) {
    stderr('pdfkiln: --scale takes a number greater than 0\n');
    return 1;
  }
  const quality = v.quality === undefined ? undefined : Number(v.quality);
  if (quality !== undefined && !(Number.isInteger(quality) && quality >= 1 && quality <= 100)) {
    stderr('pdfkiln: --quality takes a number from 1 to 100\n');
    return 1;
  }
  if (image) {
    if (inputs.length > 1) {
      stderr('pdfkiln: an image takes one input\n');
      return 1;
    }
    if (quality !== undefined && image === 'png') {
      stderr('pdfkiln: --quality is for JPEG and WebP: PNG is lossless\n');
      return 1;
    }
    if (v.transparent && image === 'jpeg') {
      stderr('pdfkiln: --transparent is for PNG and WebP: JPEG has no transparency\n');
      return 1;
    }
  }
  if (v.from !== undefined && v.from !== 'markdown') {
    stderr('pdfkiln: --from takes markdown\n');
    return 1;
  }
  // Whether an input is a PDF made elsewhere: a file's or an http(s) URL's
  // name, whatever --from says. The standard input is never one.
  const localPath = (input: string): string | null => {
    if (input === '-') return null;
    return URL_INPUT.test(input) ? (/^file:/i.test(input) ? filePath(URL.parse(input)?.href ?? '') : null) : resolve(input);
  };
  const pdfPath = (input: string): string | null => {
    const path = localPath(input);
    return path && PDF_NAME.test(path) ? path : null;
  };
  const pdfUrl = (input: string): string | null => {
    const u = /^https?:/i.test(input) ? URL.parse(input) : null;
    return u && PDF_NAME.test(u.pathname) ? u.href : null;
  };
  const isPdf = (input: string) => pdfPath(input) !== null || pdfUrl(input) !== null;
  // Whether an input is Markdown: --from, or a file's or an http(s) URL's
  // name. - is HTML but with --from markdown; any other URL is HTML.
  const markdownPath = (input: string): string | null => {
    const path = isPdf(input) ? null : localPath(input);
    return path && (v.from === 'markdown' || MARKDOWN_NAME.test(path)) ? path : null;
  };
  const markdownUrl = (input: string): string | null => {
    const u = /^https?:/i.test(input) && !isPdf(input) ? URL.parse(input) : null;
    return u && (v.from === 'markdown' || MARKDOWN_NAME.test(u.pathname)) ? u.href : null;
  };
  const isMarkdown = (input: string) => (input === '-' ? v.from === 'markdown' : markdownPath(input) !== null || markdownUrl(input) !== null);
  for (const input of inputs) {
    if (v.from === 'markdown' && input !== '-' && /^data:/i.test(input)) {
      stderr(`pdfkiln: could not load ${input}: Markdown is read from a file, an http or https URL or the standard input, not from a data: URL\n`);
      return 1;
    }
  }
  const anyMarkdown = inputs.some(isMarkdown);
  if (v.tagged && inputs.length > 1) {
    stderr('pdfkiln: --tagged takes one input: the structure trees of several documents are not merged yet\n');
    return 1;
  }
  const media = v.media ?? (image ? 'screen' : 'print');
  if (media !== 'print' && media !== 'screen') {
    stderr('pdfkiln: --media takes print or screen\n');
    return 1;
  }
  let css: string | undefined;
  if (v.css !== undefined) {
    try {
      css = readFileSync(v.css, 'utf8');
    } catch {
      stderr(`pdfkiln: --css: cannot read ${v.css}\n`);
      return 1;
    }
  }
  const headers: [string, string][] = [];
  for (const h of v.header ?? []) {
    const m = /^([!#$%&'*+.^`|~\w-]+):[ \t]*([^\r\n]*)$/.exec(h);
    if (!m) {
      stderr(`pdfkiln: --header takes "name: value", not ${h}\n`);
      return 1;
    }
    headers.push([m[1]!, m[2]!.trimEnd()]);
  }
  const cookies: [string, string][] = [];
  for (const c of v.cookie ?? []) {
    const m = /^([^=;\s]+)=([^;\r\n]*)$/.exec(c);
    if (!m) {
      stderr(`pdfkiln: --cookie takes name=value, not ${c}\n`);
      return 1;
    }
    cookies.push([m[1]!, m[2]!]);
  }
  // --pdfa and --factur-x, checked now: a mistake costs no render.
  let archived: ArchiveRequest | undefined;
  if (v.pdfa !== undefined || v['factur-x'] !== undefined) {
    const { archiveRequest } = await import('../pdf/archive.js');
    try {
      archived = archiveRequest(v.pdfa, v['factur-x']);
    } catch (e) {
      stderr(`pdfkiln: ${(e as Error).message}\n`);
      return 1;
    }
  }
  // A PDF input goes into a PDF as it is: no image is made of it, no
  // structure tree read from it. With --pdfa or --factur-x, each must be
  // PDF/A itself (archivable), checked once read.
  const firstPdf = inputs.find(isPdf);
  if (firstPdf !== undefined && (image || v.tagged)) {
    stderr(image
      ? `pdfkiln: an image is made from HTML or Markdown, not from a PDF (${firstPdf})\n`
      : `pdfkiln: --tagged takes an HTML or Markdown input, not a PDF (${firstPdf})\n`);
    return 1;
  }
  const archiveOption = v['factur-x'] !== undefined ? '--factur-x' : '--pdfa';
  // The passwords and the restrictions, for pdf-lib's AES-256. A restriction
  // binds whoever opens the PDF without the owner's password: without one,
  // pdf-lib makes the user's password the owner's, and anyone may lift it.
  // Every right is given but those refused: pdf-lib gives none unless told,
  // and never the reading of the text by screen readers.
  const userPassword = v['user-password'];
  const ownerPassword = v['owner-password'];
  const restrictions = (['no-print', 'no-copy', 'no-modify'] as const).filter((name) => v[name]);
  let protection: Parameters<PDFDocument['encrypt']>[0] | undefined;
  if (userPassword !== undefined || ownerPassword !== undefined || restrictions.length) {
    const asked = userPassword !== undefined ? '--user-password' : ownerPassword !== undefined ? '--owner-password' : `--${restrictions[0]}`;
    const refusal = userPassword === '' || ownerPassword === ''
      ? `--${userPassword === '' ? 'user' : 'owner'}-password takes a password`
      : archived
        ? `${archiveOption} and ${asked} do not go together: PDF/A forbids encryption`
        : restrictions.length && ownerPassword === undefined
          ? `--${restrictions[0]} needs --owner-password: without it, whoever opens the PDF may lift the restriction`
          : ownerPassword !== undefined && ownerPassword === userPassword
            ? '--owner-password must differ from --user-password, or it gives every right to whoever opens the PDF'
            : '';
    if (refusal) {
      stderr(`pdfkiln: ${refusal}\n`);
      return 1;
    }
    const modify = !v['no-modify'];
    protection = {
      userPassword: userPassword ?? '',
      ownerPassword,
      permissions: {
        printing: v['no-print'] ? false : 'highResolution',
        copying: !v['no-copy'],
        modifying: modify,
        annotating: modify,
        fillingForms: modify,
        documentAssembly: modify,
        contentAccessibility: true,
      },
    };
  }
  // Chromium, for any input but a PDF file: a PDF from a URL is fetched with
  // Chromium's user agent, as Markdown is.
  const chromium = inputs.some((input) => pdfPath(input) === null);
  const blockPrivate = !v['allow-private-network'];
  const insecure = Boolean(v['allow-invalid-certificates']);

  let relay: Relay | undefined;
  // Why a request did not load, in a few words. The relay knows why it
  // could not reach a host, where Chromium sees its 403, its 502 or a
  // closed connection; another status is the server's.
  const why = (url: string, f: Failure): string => {
    const host = URL.parse(url)?.hostname ?? '';
    const e = typeof f === 'number' && f !== 403 && f !== 502 ? f : relay?.failure(host) ?? f;
    if (e instanceof BlockedAddress) {
      return `${host} ${isIP(host.replace(/^\[|\]$/g, '')) ? 'is' : 'resolves to'} a private address (--allow-private-network to reach it)`;
    }
    if (typeof e === 'number') return `HTTP ${e}`;
    // A font, refused here: the system's name of the reason.
    if (e instanceof CertificateError) return e.message;
    return words(e instanceof Error ? (e as NodeJS.ErrnoException).code ?? e.message : e);
  };
  // Why the current input did not load.
  let failure = '';
  const warning = (m: string) => {
    if (!v.quiet) stderr(`pdfkiln: warning: ${m}\n`);
  };
  // With --fail-on-resource-error, the resources of the input that did not
  // load, each once.
  const unloaded = new Set<string>();
  const out: Reporter = {
    warning,
    error: (m) => stderr(`pdfkiln: error: ${m}\n`),
    // A resource that does not load is a warning, or kept for the errors
    // below; the input itself, the error below.
    failed: (url, f, page) => {
      if (page) failure ||= why(url, f);
      else if (v['fail-on-resource-error']) unloaded.add(`could not load ${url}: ${why(url, f)}`);
      else warning(`could not load ${url}: ${why(url, f)}`);
    },
  };
  // A frame loaded apart (src/engine/frames.ts) is a resource of the input,
  // the frame's own address included.
  const frameOut: Reporter = { ...out, failed: (url, f) => out.failed!(url, f, false) };
  // Whether the input lacks a resource: then all of them, as errors, which
  // -q does not hide.
  const incomplete = (): boolean => {
    for (const m of unloaded) out.error(m);
    return unloaded.size > 0;
  };
  // A PDF input, read and checked: its document, or false once its error
  // is said.
  const takePdf = async (input: string, bytes: Buffer): Promise<PDFDocument | false> => {
    const [lib] = await pdfModules();
    const doc = await readPdf(lib, bytes);
    if (typeof doc === 'string') {
      out.error(`could not load ${input}: ${doc}`);
      return false;
    }
    if (archived) {
      const { archivable } = await import('../pdf/archive.js');
      const reason = archivable(doc, archived.level);
      if (reason) {
        stderr(`pdfkiln: ${archiveOption}: ${input} ${reason}\n`);
        return false;
      }
    }
    return doc;
  };
  const work = mkdtempSync(join(tmpdir(), 'pdfkiln-'));
  let session: Session | undefined;
  let stop = () => {};
  try {
    step('options');
    // The PDF files, read now: one that cannot go in costs no render. Each
    // occurrence is read apart, its links pinned in its own copy (merge).
    const pdfFiles = new Map<number, PDFDocument>();
    for (const [i, input] of inputs.entries()) {
      const path = pdfPath(input);
      if (!path) continue;
      const unusable = notAFile(input, pathToFileURL(path).href);
      if (unusable) {
        out.error(`could not load ${input}: ${unusable}`);
        return 1;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch (e) {
        out.error(`could not load ${input}: ${words((e as NodeJS.ErrnoException).code ?? String(e))}`);
        return 1;
      }
      const doc = await takePdf(input, bytes);
      if (!doc) return 1;
      pdfFiles.set(i, doc);
    }
    if (pdfFiles.size) step('pdf');
    if (blockPrivate && chromium) relay = await startRelay();
    step('relay');
    if (v['no-sandbox'] && chromium) out.warning("Chromium's sandbox is off (--no-sandbox)");
    if (chromium) session = await launch({
      dir: work,
      noSandbox: v['no-sandbox'],
      proxyServer: relay?.url,
      proxyBypassList: relay ? '<-loopback>' : undefined,
      ignoreCertificateErrors: insecure,
      meanwhile: () => {
        if (!image) void pdfModules().catch(() => {});
        if (anyMarkdown) void markdownModule().then((m) => m.prepare()).catch(() => {});
      },
    });
    step('launch');
    // pdf-lib, which an image does not need.
    const pdfLib = image ? undefined : await pdfModules();
    step('modules');
    const late = () => {
      removeQuietly(work);
      stderr(`pdfkiln: error: the conversion took longer than ${timeout} s (--timeout)\n`);
      process.exit(1);
    };
    stop = session ? deadline(session, timeout, late) : timer(timeout, late);
    const context = session?.browser.defaultBrowserContext();
    // A Markdown URL, fetched here with the relay's check at every redirect
    // and Chromium's user agent; --header and --cookie go to its host
    // only, as with a page. A redirect elsewhere than http(s) is its status.
    const userAgent = session ? await session.browser.userAgent() : '';
    const fetchUrl = async (start: string): Promise<{ status: number; body: Buffer; url: string }> => {
      const host = URL.parse(start)?.hostname;
      let at = start;
      for (let hop = 0; ; hop++) {
        const h: Record<string, string> = { 'user-agent': userAgent };
        if (URL.parse(at)?.hostname === host) {
          for (const [name, value] of headers) h[name.toLowerCase()] = value;
          if (cookies.length) h.cookie = cookies.map(([name, value]) => `${name}=${value}`).join('; ');
        }
        const r = await relayRequest(at, { block: blockPrivate, insecure, headers: h });
        const location = r.headers.find(([k]) => k.toLowerCase() === 'location')?.[1];
        const next = location && r.status >= 300 && r.status < 400 && hop < 10 ? URL.parse(location, at) : null;
        if (next && /^https?:$/.test(next.protocol)) {
          at = next.href;
          continue;
        }
        return { status: r.status, body: r.body, url: at };
      }
    };
    const base = defaultObject();
    base.load.jsdelay = jsdelay;
    base.load.blockLocalFileAccess = !v['enable-local-file-access'];
    base.load.allowed = v.allow ?? [];
    base.load.cookies = cookies;
    let stdin: Buffer | undefined;
    // The front matter of the first Markdown input that has one.
    let front: FrontMatter | undefined;
    const parts: { doc: PDFDocument; outline: OutlineItem[]; pdf?: boolean }[] = [];
    for (const [i, input] of inputs.entries()) {
      let url: string;
      const mdPath = markdownPath(input);
      const markdown = isMarkdown(input);
      if (input === '-') {
        stdin ??= readFileSync(0);
        const file = join(work, `stdin-${i}.html`);
        writeFileSync(file, stdin);
        url = pathToFileURL(file).href;
      } else url = URL_INPUT.test(input) ? URL.parse(input)?.href ?? '' : pathToFileURL(resolve(input)).href;
      const unusable = url ? notAFile(input, url) : 'not a valid URL';
      if (unusable) {
        out.error(`could not load ${input}: ${unusable}`);
        return 1;
      }
      // A PDF made elsewhere: read, fetched for a URL under the rules of a
      // page, and its pages added as they are.
      const pdfAt = pdfUrl(input);
      if (pdfFiles.has(i) || pdfAt) {
        let doc = pdfFiles.get(i);
        if (!doc) {
          let r: { status: number; body: Buffer };
          try {
            r = await fetchUrl(pdfAt!);
          } catch (e) {
            out.error(`could not load ${input}: ${why(pdfAt!, e as Error)}`);
            return 1;
          }
          if (r.status < 200 || r.status >= 300) {
            out.error(`could not load ${input}: HTTP ${r.status}`);
            return 1;
          }
          const taken = await takePdf(input, r.body);
          if (!taken) return 1;
          doc = taken;
          step('pdf');
        }
        const [, { readOutline }] = pdfLib!;
        parts.push({ doc, outline: v.outline ? readOutline(doc) : [], pdf: true });
        continue;
      }
      // A PDF on the standard input would be printed as text.
      if (input === '-' && isPdfData(stdin!)) {
        out.error('could not load -: the standard input is a PDF: give it as a file named .pdf');
        return 1;
      }
      // Markdown: the page printed is its HTML, written next to the others
      // of the conversion; its folder (the working directory for -), or the
      // directory of its URL, is what its relative links and images name,
      // and only from a file may its images be read there.
      let allowFiles: string[] | undefined;
      let web = base.web;
      // The URL whose host gets --header and --cookie, when it is not the
      // page's: Markdown read from a URL.
      let site: string | undefined;
      if (markdown) {
        const mdUrl = markdownUrl(input);
        let text: string;
        try {
          if (mdUrl) {
            const r = await fetchUrl(mdUrl);
            if (r.status < 200 || r.status >= 300) {
              out.error(`could not load ${input}: HTTP ${r.status}`);
              return 1;
            }
            text = r.body.toString('utf8');
            site = r.url;
          } else text = (mdPath ? readFileSync(mdPath) : stdin!).toString('utf8');
        } catch (e) {
          out.error(`could not load ${input}: ${mdUrl ? why(mdUrl, e as Error) : words((e as NodeJS.ErrnoException).code ?? String(e))}`);
          return 1;
        }
        const folder = mdPath ? dirname(mdPath) : process.cwd();
        const file = join(work, `markdown-${i}.html`);
        url = pathToFileURL(file).href;
        const { markdownPage } = await markdownModule();
        const at = site ? URL.parse(site)! : undefined;
        const md = markdownPage(text, at
          ? {
            base: new URL('.', at).href,
            document: at.href.replace(/#.*$/, ''),
            name: decoded(posix.basename(at.pathname, posix.extname(at.pathname))) || undefined,
            image: Boolean(image),
          }
          : {
            base: pathToFileURL(folder.endsWith(sep) ? folder : folder + sep).href,
            document: mdPath ? pathToFileURL(mdPath).href : undefined,
            name: mdPath ? basename(mdPath, extname(mdPath)) : undefined,
            image: Boolean(image),
          });
        writeFileSync(file, md.html);
        step('markdown');
        if (mdPath) allowFiles = [folder];
        web = { ...base.web, enableJavascript: false };
        if (!front && Object.keys(md.meta).length) front = md.meta;
      }
      failure = '';
      // What the input before asked for once printed is not in the PDF.
      unloaded.clear();
      const lp = await openPage(context!, {
        url,
        web,
        load: base.load,
        allowFiles,
        isMain: true,
        media,
        viewport: image ? { width: width ?? DEFAULT_WIDTH, height: height ?? DEFAULT_HEIGHT, scale } : { width: 794, height: 1123 },
        blockPrivateNetwork: blockPrivate,
        ignoreCertificateErrors: insecure,
        // From a page printed from a file, Chromium holds the cookies of
        // the Markdown's host back (another site, SameSite): they go as a
        // header, as --header does.
        siteHeaders: site && cookies.length ? [...headers, ['Cookie', cookies.map(([name, value]) => `${name}=${value}`).join('; ')]] : headers,
        site,
        css,
        waitFor: v['wait-for'],
      }, out);
      step('load');
      // An input that does not load, or comes in HTTP error, fails: no PDF
      // of an error page.
      if (!lp.ok || lp.status >= 400) {
        out.error(`could not load ${input}: ${failure || `HTTP ${lp.status}`}`);
        return 1;
      }
      if (image) {
        const bytes = await capture(lp, { format: image, quality, transparent: Boolean(v.transparent), scale, window: height !== undefined, element: v.element }, frameOut);
        step('capture');
        // --fail-on-resource-error: once captured, the deferred images
        // loaded, so that all are told.
        if (incomplete()) return 1;
        writeOutput(output, bytes);
        step('write');
        return 0;
      }
      const [{ PDFDocument }, { fixDests, placeFrames, readOutline, undoubleTitles }] = pdfLib!;
      // --outline: the headings' text, which puts right a bookmark Chromium
      // titles twice (undoubleTitles).
      const headings = v.outline ? await headingTexts(lp.page) : [];
      // The frames Chromium prints blank: printed apart, then drawn in
      // (src/engine/frames.ts).
      const frames = await markFrames(lp);
      const pdf = await lp.page.pdf({
        format: 'A4',
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
        preferCSSPageSize: true,
        printBackground: true,
        tagged: Boolean(v.tagged || v.outline),
        outline: Boolean(v.outline),
        // Puppeteer's own 30 s would cut a long document: --timeout decides.
        timeout: 0,
      });
      const doc = await PDFDocument.load(pdf, READ);
      if (frames.length) {
        const print = printer();
        await placeFrames(doc, frames, PT_PER_PX, (m, w, h) => print(`${m.url} ${Math.round(w)} ${Math.round(h)}`, () => printApart(lp, m, w, h, true, frameOut)));
        step('frames');
      }
      // --fail-on-resource-error: once printed, which asks for what the
      // load left (lazy images), and the frames printed apart, so that all
      // are told.
      if (incomplete()) return 1;
      await lp.page.close();
      // Markdown's targets move by its style sheet's margins.
      if (markdown) fixDests(doc, MARGIN_LEFT_CM * CM_PT, MARGIN_TOP_CM * CM_PT, 1);
      else fixDests(doc, CM_PT, CM_PT, 1);
      parts.push({ doc, outline: v.outline ? undoubleTitles(readOutline(doc), headings) : [] });
      step('print');
    }
    const [{ PDFName, PDFString }, { indirectStrings, merge, moveDest, prune, writeOutline }] = pdfLib!;
    const merged = await merge(parts, Boolean(v.tagged));
    prune(merged.doc);
    if (v.outline) {
      // A bookmark that goes to no page of the document, a folder of a PDF
      // made elsewhere for instance, goes to its first child's; with no
      // child that does, it goes.
      const toFinal = (items: OutlineItem[], k: number): FinalItem[] => items.flatMap((it) => {
        const children = toFinal(it.children, k);
        if (it.dest && it.page >= 0) return [{ title: it.title, dest: moveDest(merged.doc, it.dest, merged.pages[merged.offsets[k]! + it.page]!), children }];
        return children.length ? [{ title: it.title, dest: children[0]!.dest, children }] : [];
      });
      writeOutline(merged.doc, parts.flatMap((p, k) => toFinal(p.outline, k)));
    }
    merged.doc.setCreator(`PDFKiln ${version}`);
    merged.doc.setProducer('pdfkiln.org');
    // The title Chromium gave, the page's (Markdown's: its front matter's,
    // its first heading or its file's name), unless --title; the others
    // when given, or from the front matter of Markdown.
    if (v.title !== undefined) merged.doc.setTitle(v.title);
    // A document whose first input is a PDF starts empty: its title is that
    // PDF's.
    else if (parts[0]!.pdf) {
      const title = parts[0]!.doc.getTitle();
      if (title) merged.doc.setTitle(title);
    }
    const author = v.author ?? front?.author;
    if (author !== undefined) merged.doc.setAuthor(author);
    const subject = v.subject ?? front?.subject;
    if (subject !== undefined) merged.doc.setSubject(subject);
    const keywords = v.keywords !== undefined ? [v.keywords] : front?.keywords;
    if (keywords !== undefined) merged.doc.setKeywords([keywords.join(', ')]);
    // The language, for readers and screen readers: Chromium writes it in a
    // tagged PDF only.
    if (front?.lang && !merged.doc.catalog.has(PDFName.of('Lang'))) merged.doc.catalog.set(PDFName.of('Lang'), PDFString.of(front.lang));
    if (protection) {
      indirectStrings(merged.doc);
      merged.doc.encrypt(protection);
    }
    let bytes: Uint8Array = await merged.doc.save(WRITE);
    step('assemble');
    if (archived) {
      const { archive } = await import('../pdf/archive.js');
      bytes = await archive(bytes, archived);
      step('archive');
    }
    writeOutput(output, bytes);
    step('write');
    return 0;
  } catch (e) {
    // Cut off by --timeout, which says so itself.
    if (session?.stopping) return 1;
    if (e instanceof LaunchError) {
      out.error(e.message);
      return 1;
    }
    out.error(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    stop();
    await session?.close();
    await relay?.close();
    removeQuietly(work);
    step('close');
    if (process.env.PDFKILN_TIMINGS) stderr(`${JSON.stringify(timings)}\n`);
  }
}
