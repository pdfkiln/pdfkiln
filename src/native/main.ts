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
//   or --enable-local-file-access, and reaches no loopback, private or
//   link-local address unless --allow-private-network;
// - an input that does not load fails: exit 1, no PDF; with
//   --fail-on-resource-error, so does an input one of whose resources does
//   not;
// - its own messages, with why: one error for an input that does not load,
//   a warning for each resource that does not (-q hides them), or with
//   --fail-on-resource-error an error for each, once the input has loaded
//   and printed;
// - --title, --author, --subject and --keywords: the PDF's properties, the
//   title being the page's otherwise;
// - Markdown, from a file named .md or .markdown, or with --from markdown:
//   GitHub's dialect and math, printed with pdfkiln's style sheet
//   (src/markdown/), without JavaScript; its images may come from the
//   document's folder, and its front matter gives the properties that no
//   option does.
import { mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { PDFDocument } from '@cantoo/pdf-lib';
import type { Page } from 'puppeteer-core';
import { deadline, launch, LaunchError, removeQuietly, type Session } from '../engine/browser.js';
import { filePath } from '../engine/files.js';
import { openPage, type Failure, type Reporter } from '../engine/loader.js';
import { BlockedAddress, startRelay, type Relay } from '../engine/relay.js';
import type { FrontMatter } from '../markdown/frontmatter.js';
import { MARGIN_LEFT_CM, MARGIN_TOP_CM } from '../markdown/style.js';
import type { Request as ArchiveRequest } from '../pdf/archive.js';
import type { FinalItem, OutlineItem } from '../pdf/assemble.js';
import { pdfModules, READ, WRITE } from '../pdf/modules.js';
import { chromiumVersion, version } from '../version.js';
import { defaultObject } from '../wk/settings.js';

const HELP = `PDFKiln: HTML and Markdown to PDF with Chromium

Usage:
  pdfkiln [options] <input>... <output>
  pdfkiln <command> [options]

Examples:
  pdfkiln invoice.html invoice.pdf
  pdfkiln https://example.com/report report.pdf
  pdfkiln cover.html body.html book.pdf     # merged in order
  pdfkiln - - < page.html > page.pdf        # standard input and output
  pdfkiln notes.md notes.pdf                # Markdown

Inputs are files, URLs (http:, https:, file:, data:) or - for the standard
input; the output is a file, or - for the standard output. Paper size,
margins, headers and footers come from the page's CSS (@page and its margin
boxes): A4 with 1 cm margins otherwise.

Files named .md or .markdown are Markdown: GitHub's dialect, with math
($...$, $$...$$) and a front matter, printed with PDFKiln's style sheet,
without JavaScript. Its images may come from the document's folder.

Rendering:
  --from markdown             Read every input as Markdown, whatever its name
                              (README, notes.txt, the standard input)
  --css <file>                Add a style sheet after the page's own
  --media <print|screen>      CSS media type (default: print)
  --outline                   Bookmarks from the headings
  --tagged                    Tagged PDF, for screen readers (one input)

Document properties (default: from the front matter of Markdown):
  --title <text>              Title (default: the page's <title>)
  --author <text>             Author
  --subject <text>            Subject
  --keywords <text>           Keywords

PDF/A and electronic invoices:
  --pdfa[=<level>]            PDF/A for archiving: 2b, 2u, 3b, 3u (default 3b)
  --factur-x <invoice.xml>    Attach the invoice's CII XML: a Factur-X or
                              ZUGFeRD invoice, in PDF/A-3

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

Exit code: 0 once the PDF is written, 1 otherwise, with the reason.
Docs: https://pdfkiln.org
`;

const stderr = (s: string) => writeSync(2, s);
// The 1 cm margins in points; an @page margin of the page moves its
// internal links' targets by the difference.
const CM_PT = 72 / 2.54;

// An input is a URL when it says so, a file otherwise: a missing file is
// not looked for on the web, as wkhtmltopdf's guess did (report.html as
// http://report.html/).
const URL_INPUT = /^(https?|file|data):/i;

// A Markdown file; with --from markdown, every input. No --from html: Chromium
// reads a file by its name, and takes a .md one for a download.
const MARKDOWN_NAME = /\.(md|markdown)$/i;

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

function words(name: string): string {
  if (name.startsWith('net::ERR_CERT_')) return `invalid certificate (${name})`;
  if (/^(net::)?ERR_SSL_|^EPROTO$/.test(name)) return `TLS error (${name})`;
  return WORDS[name] ?? name;
}

function writeAll(fd: number, data: Uint8Array): void {
  for (let off = 0; off < data.length;) off += writeSync(fd, data, off);
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
        timeout: { type: 'string' },
        'fail-on-resource-error': { type: 'boolean' },
        title: { type: 'string' },
        author: { type: 'string' },
        subject: { type: 'string' },
        keywords: { type: 'string' },
        pdfa: { type: 'string' },
        'factur-x': { type: 'string' },
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
  if (v.from !== undefined && v.from !== 'markdown') {
    stderr('pdfkiln: --from takes markdown\n');
    return 1;
  }
  // Whether an input is Markdown: --from, or a file's name. - is HTML but
  // with --from markdown; a URL is read as it comes (file: aside).
  const markdownPath = (input: string): string | null => {
    if (input === '-') return null;
    const path = URL_INPUT.test(input) ? (/^file:/i.test(input) ? filePath(URL.parse(input)?.href ?? '') : null) : resolve(input);
    return path && (v.from === 'markdown' || MARKDOWN_NAME.test(path)) ? path : null;
  };
  const isMarkdown = (input: string) => (input === '-' ? v.from === 'markdown' : markdownPath(input) !== null);
  for (const input of inputs) {
    if (v.from === 'markdown' && input !== '-' && URL_INPUT.test(input) && !/^file:/i.test(input)) {
      stderr(`pdfkiln: could not load ${input}: Markdown is read from a file or the standard input, not from a URL\n`);
      return 1;
    }
  }
  const anyMarkdown = inputs.some(isMarkdown);
  if (v.tagged && inputs.length > 1) {
    stderr('pdfkiln: --tagged takes one input: the structure trees of several documents are not merged yet\n');
    return 1;
  }
  const media = v.media ?? 'print';
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
  const blockPrivate = !v['allow-private-network'];

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
  // Whether the input lacks a resource: then all of them, as errors, which
  // -q does not hide.
  const incomplete = (): boolean => {
    for (const m of unloaded) out.error(m);
    return unloaded.size > 0;
  };
  const work = mkdtempSync(join(tmpdir(), 'pdfkiln-'));
  let session: Session | undefined;
  let stop = () => {};
  try {
    step('options');
    if (blockPrivate) relay = await startRelay();
    step('relay');
    if (v['no-sandbox']) out.warning("Chromium's sandbox is off (--no-sandbox)");
    session = await launch({
      dir: work,
      noSandbox: v['no-sandbox'],
      proxyServer: relay?.url,
      proxyBypassList: relay ? '<-loopback>' : undefined,
      meanwhile: () => {
        void pdfModules().catch(() => {});
        if (anyMarkdown) void markdownModule().then((m) => m.prepare()).catch(() => {});
      },
    });
    step('launch');
    const [{ PDFDocument, PDFName, PDFString }, { fixDests, merge, moveDest, prune, readOutline, undoubleTitles, writeOutline }] = await pdfModules();
    step('modules');
    stop = deadline(session, timeout, () => {
      removeQuietly(work);
      stderr(`pdfkiln: error: the conversion took longer than ${timeout} s (--timeout)\n`);
      process.exit(1);
    });
    const context = session.browser.defaultBrowserContext();
    const base = defaultObject();
    base.load.jsdelay = jsdelay;
    base.load.blockLocalFileAccess = !v['enable-local-file-access'];
    base.load.allowed = v.allow ?? [];
    base.load.cookies = cookies;
    let stdin: Buffer | undefined;
    // The front matter of the first Markdown input that has one.
    let front: FrontMatter | undefined;
    const parts: { doc: PDFDocument; outline: OutlineItem[] }[] = [];
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
      // Markdown: the page printed is its HTML, written next to the others
      // of the conversion; its folder (the working directory for -) is what
      // its relative links and images name, and only from a file may its
      // images be read there.
      let allowFiles: string[] | undefined;
      let web = base.web;
      if (markdown) {
        let text: string;
        try {
          text = (mdPath ? readFileSync(mdPath) : stdin!).toString('utf8');
        } catch (e) {
          out.error(`could not load ${input}: ${words((e as NodeJS.ErrnoException).code ?? String(e))}`);
          return 1;
        }
        const folder = mdPath ? dirname(mdPath) : process.cwd();
        const file = join(work, `markdown-${i}.html`);
        url = pathToFileURL(file).href;
        const { markdownPage } = await markdownModule();
        const md = markdownPage(text, {
          base: pathToFileURL(folder.endsWith(sep) ? folder : folder + sep).href,
          document: mdPath ? pathToFileURL(mdPath).href : undefined,
          name: mdPath ? basename(mdPath, extname(mdPath)) : undefined,
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
      const lp = await openPage(context, {
        url,
        web,
        load: base.load,
        allowFiles,
        isMain: true,
        media,
        viewport: { width: 794, height: 1123 },
        blockPrivateNetwork: blockPrivate,
        siteHeaders: headers,
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
      // --outline: the headings' text, which puts right a bookmark Chromium
      // titles twice (undoubleTitles).
      const headings = v.outline ? await headingTexts(lp.page) : [];
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
      // --fail-on-resource-error: once printed, which asks for what the
      // load left (lazy images), so that all are told.
      if (incomplete()) return 1;
      await lp.page.close();
      const doc = await PDFDocument.load(pdf, READ);
      // Markdown's targets move by its style sheet's margins.
      if (markdown) fixDests(doc, MARGIN_LEFT_CM * CM_PT, MARGIN_TOP_CM * CM_PT, 1);
      else fixDests(doc, CM_PT, CM_PT, 1);
      parts.push({ doc, outline: v.outline ? undoubleTitles(readOutline(doc), headings) : [] });
      step('print');
    }
    const merged = await merge(parts, Boolean(v.tagged));
    prune(merged.doc);
    if (v.outline) {
      const toFinal = (items: OutlineItem[], k: number): FinalItem[] => items
        .filter((it) => it.dest && it.page >= 0)
        .map((it) => ({ title: it.title, dest: moveDest(merged.doc, it.dest!, merged.pages[merged.offsets[k]! + it.page]!), children: toFinal(it.children, k) }));
      writeOutline(merged.doc, parts.flatMap((p, k) => toFinal(p.outline, k)));
    }
    merged.doc.setCreator(`PDFKiln ${version}`);
    merged.doc.setProducer('pdfkiln.org');
    // The title Chromium gave, the page's (Markdown's: its front matter's,
    // its first heading or its file's name), unless --title; the others
    // when given, or from the front matter of Markdown.
    if (v.title !== undefined) merged.doc.setTitle(v.title);
    const author = v.author ?? front?.author;
    if (author !== undefined) merged.doc.setAuthor(author);
    const subject = v.subject ?? front?.subject;
    if (subject !== undefined) merged.doc.setSubject(subject);
    const keywords = v.keywords !== undefined ? [v.keywords] : front?.keywords;
    if (keywords !== undefined) merged.doc.setKeywords([keywords.join(', ')]);
    // The language, for readers and screen readers: Chromium writes it in a
    // tagged PDF only.
    if (front?.lang && !merged.doc.catalog.has(PDFName.of('Lang'))) merged.doc.catalog.set(PDFName.of('Lang'), PDFString.of(front.lang));
    let bytes: Uint8Array = await merged.doc.save(WRITE);
    step('assemble');
    if (archived) {
      const { archive } = await import('../pdf/archive.js');
      bytes = await archive(bytes, archived);
      step('archive');
    }
    if (output === '-') writeAll(1, bytes);
    else writeFileSync(output, bytes);
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
