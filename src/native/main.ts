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
// - an input that does not load fails: exit 1, no PDF;
// - its own messages, with why: one error for an input that does not load,
//   a warning for each resource that does not (-q hides them).
import { mkdtempSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from '@cantoo/pdf-lib';
import { deadline, launch, LaunchError, removeQuietly, type Session } from '../engine/browser.js';
import { filePath } from '../engine/files.js';
import { openPage, type Failure, type Reporter } from '../engine/loader.js';
import { BlockedAddress, startRelay, type Relay } from '../engine/relay.js';
import { fixDests, merge, moveDest, prune, readOutline, writeOutline, type FinalItem, type OutlineItem } from '../pdf/assemble.js';
import { chromiumVersion, version } from '../version.js';
import { defaultObject } from '../wk/settings.js';

const HELP = `Usage: pdfkiln [options] <input>... <output>

Converts HTML to PDF with Chromium. Inputs are files, URLs (http:, https:,
file: or data:), or - for the standard input; they are merged in order. The
output is a file, or - for the standard output. Paper size, margins, headers
and footers come from the page's CSS (@page and its margin boxes); A4 with
1 cm margins otherwise.

Options:
  --tagged                  Tagged PDF, readable by screen readers (one input)
  --outline                 Bookmarks from the headings
  --css <file>              Apply this style sheet after the page's own
  --media <type>            CSS media type: print (default) or screen
  --javascript-delay <ms>   Wait up to this long after loading (default 1000,
                            0: none), less once nothing can change the page
  --wait-for <selector>     Wait for an element that matches this CSS selector,
                            then for --javascript-delay; --timeout bounds it
  --header <name: value>    Send this HTTP header with every request to the
                            input's host, no other (repeatable)
  --cookie <name=value>     Send this cookie to the input's host (repeatable)
  --allow <path>            Let local pages read files under this path
                            (repeatable)
  --enable-local-file-access  Let local pages read any local file
  --allow-private-network   Let pages reach loopback, private and link-local
                            addresses, refused by default
  --timeout <seconds>       Stop after this many seconds (default 120, 0: none)
  --no-sandbox              Run Chromium without its sandbox (not recommended)
  -q, --quiet               No warnings
  -V, --version             Show the version
  -h, --help                Show this help

Called as wkhtmltopdf or wkhtmltoimage, or as "pdfkiln wkhtmltopdf <options>"
or "pdfkiln wkhtmltoimage <options>", PDFKiln is compatible with wkhtmltopdf
and wkhtmltoimage 0.12.6 instead. "pdfkiln serve" keeps Chromium open for
their conversions (pdfkiln serve --help).
`;

const stderr = (s: string) => writeSync(2, s);
// The 1 cm margins in points; an @page margin of the page moves its
// internal links' targets by the difference.
const CM_PT = 72 / 2.54;

// An input is a URL when it says so, a file otherwise: a missing file is
// not looked for on the web, as wkhtmltopdf's guess did (report.html as
// http://report.html/).
const URL_INPUT = /^(https?|file|data):/i;

// What keeps a file from being an input: missing, or not a file. A missing
// one named like a host (www.example.com, localhost:8080/page, 10.0.0.5),
// not like a page (report.html), was meant as a URL.
function notAFile(input: string, url: string): string {
  if (!url.startsWith('file:')) return '';
  const path = filePath(url);
  const st = path ? statSync(path, { throwIfNoEntry: false }) : undefined;
  if (st) return st.isFile() ? '' : 'not a file';
  const host = /^([^/\\:]+)(:\d+)?(\/|$)/.exec(input)?.[1] ?? '';
  const page = /\.(x?html?|xml|svg|txt|pdf|json|css|js)$/i.test(host);
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

export async function nativeMain(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        tagged: { type: 'boolean' },
        outline: { type: 'boolean' },
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
  const out: Reporter = {
    warning,
    error: (m) => stderr(`pdfkiln: error: ${m}\n`),
    // A resource that does not load is a warning; the input itself, the
    // error below.
    failed: (url, f, page) => {
      if (page) failure ||= why(url, f);
      else warning(`could not load ${url}: ${why(url, f)}`);
    },
  };
  const work = mkdtempSync(join(tmpdir(), 'pdfkiln-'));
  let session: Session | undefined;
  let stop = () => {};
  try {
    if (blockPrivate) relay = await startRelay();
    if (v['no-sandbox']) out.warning("Chromium's sandbox is off (--no-sandbox)");
    session = await launch({ dir: work, noSandbox: v['no-sandbox'], proxyServer: relay?.url, proxyBypassList: relay ? '<-loopback>' : undefined });
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
    const parts: { doc: PDFDocument; outline: OutlineItem[] }[] = [];
    for (const [i, input] of inputs.entries()) {
      let url: string;
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
      failure = '';
      const lp = await openPage(context, {
        url,
        web: base.web,
        load: base.load,
        isMain: true,
        media,
        viewport: { width: 794, height: 1123 },
        blockPrivateNetwork: blockPrivate,
        siteHeaders: headers,
        css,
        waitFor: v['wait-for'],
      }, out);
      // An input that does not load, or comes in HTTP error, fails: no PDF
      // of an error page.
      if (!lp.ok || lp.status >= 400) {
        out.error(`could not load ${input}: ${failure || `HTTP ${lp.status}`}`);
        return 1;
      }
      const pdf = await lp.page.pdf({
        format: 'A4',
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
        preferCSSPageSize: true,
        printBackground: true,
        tagged: Boolean(v.tagged || v.outline),
        outline: Boolean(v.outline),
      });
      await lp.page.close();
      const doc = await PDFDocument.load(pdf, { updateMetadata: false });
      fixDests(doc, CM_PT, CM_PT, 1);
      parts.push({ doc, outline: v.outline ? readOutline(doc) : [] });
    }
    const merged = await merge(parts, Boolean(v.tagged));
    prune(merged.doc);
    if (v.outline) {
      const toFinal = (items: OutlineItem[], k: number): FinalItem[] => items
        .filter((it) => it.dest && it.page >= 0)
        .map((it) => ({ title: it.title, dest: moveDest(merged.doc, it.dest!, merged.pages[merged.offsets[k]! + it.page]!), children: toFinal(it.children, k) }));
      writeOutline(merged.doc, parts.flatMap((p, k) => toFinal(p.outline, k)));
    }
    merged.doc.setCreator('PDFKiln');
    merged.doc.setProducer('pdfkiln.org');
    const bytes = await merged.doc.save();
    if (output === '-') writeAll(1, bytes);
    else writeFileSync(output, bytes);
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
  }
}
