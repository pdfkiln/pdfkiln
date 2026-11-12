// The 122 options of wkhtmltopdf 0.12.6, in the order of its source
// (src/pdf/pdfarguments.cc, src/shared/commonarguments.cc), and ours.
// test/options.test.ts checks names, short forms, sections and argument
// counts against a list extracted from that source.
import type { LoadErrorHandling, LogLevel, PdfGlobal, PdfObject, Proxy } from './settings.js';
import { LOG_LEVELS } from './settings.js';
import { strToFloat, strToInt, strToPageSize, strToUnitReal } from './units.js';

// Where an option may appear: before the first page (global, which also
// takes page options as defaults for every page), after a page or cover,
// or after "toc".
export type Mode = 'global' | 'page' | 'toc';

// yes: implemented. noop: accepted without effect, with a warning.
// silent: accepted without effect or message (passed by libraries on every
// call).
export type Support = 'yes' | 'noop' | 'silent';

export type Action = 'help' | 'extended-help' | 'version' | 'license' | 'manpage' | 'htmldoc' | 'readme' | 'dump-default-toc-xsl';

export interface Target { g: PdfGlobal; o: PdfObject }

export interface OptionSpec {
  name: string;
  short?: string;
  mode: Mode;
  args: string[];
  support: Support;
  desc: string;
  // Returns false when the argument is invalid. An action ends parsing.
  apply?: (t: Target, a: string[]) => boolean;
  action?: Action;
}

const set = <T>(f: (t: Target, v: T) => void, parse: (s: string) => T | null) => (t: Target, a: string[]) => {
  const v = parse(a[0]!);
  if (v === null) return false;
  f(t, v);
  return true;
};
const flag = (f: (t: Target) => void) => (t: Target) => {
  f(t);
  return true;
};
const str = (s: string) => s;
const unit = strToUnitReal;
const int = strToInt;
const float = strToFloat;
const handling = (s: string): LoadErrorHandling | null =>
  (['abort', 'skip', 'ignore'] as const).find((h) => h === s.toLowerCase()) ?? null;
const logLevel = (s: string): LogLevel | null => LOG_LEVELS.find((l) => l === s.toLowerCase()) ?? null;
const orientation = (s: string) =>
  s.toLowerCase() === 'landscape' ? 'Landscape' as const : s.toLowerCase() === 'portrait' ? 'Portrait' as const : null;

// src/lib/loadsettings.cc strToProxy: [http://|socks5://][user[:password]@]host[:port].
export function strToProxy(s: string): Proxy | null | undefined {
  if (s === 'none') return null;
  let rest = s;
  let type: Proxy['type'] = 'http';
  if (rest.startsWith('http://')) rest = rest.slice(7);
  else if (rest.startsWith('socks5://')) {
    type = 'socks5';
    rest = rest.slice(9);
  }
  let user = '';
  let password = '';
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
    const colon = user.indexOf(':');
    if (colon !== -1) {
      password = user.slice(colon + 1);
      user = user.slice(0, colon);
    }
  }
  let port = 1080;
  let host = rest;
  const colon = rest.indexOf(':');
  if (colon !== -1) {
    const p = strToInt(rest.slice(colon + 1));
    if (p === null || p < 0 || p > 65535) return undefined;
    port = p;
    host = rest.slice(0, colon);
  }
  if (!host) return undefined;
  return { type, host, port, user, password };
}

const G = 'global' as const;
const P = 'page' as const;
const T = 'toc' as const;

export const OPTIONS: OptionSpec[] = [
  // Global options.
  { name: 'help', short: 'h', mode: G, args: [], support: 'yes', desc: 'Display help', action: 'help' },
  { name: 'version', short: 'V', mode: G, args: [], support: 'yes', desc: 'Output version information and exit', action: 'version' },
  { name: 'license', mode: G, args: [], support: 'yes', desc: 'Output license information and exit', action: 'license' },
  { name: 'extended-help', short: 'H', mode: G, args: [], support: 'yes', desc: 'Display help, including less common options', action: 'extended-help' },
  { name: 'manpage', mode: G, args: [], support: 'yes', desc: 'Output the help as a man page', action: 'manpage' },
  { name: 'htmldoc', mode: G, args: [], support: 'yes', desc: 'Output the help as HTML', action: 'htmldoc' },
  { name: 'readme', mode: G, args: [], support: 'yes', desc: 'Output the help as plain text', action: 'readme' },
  { name: 'quiet', short: 'q', mode: G, args: [], support: 'yes', desc: 'Same as --log-level none', apply: flag((t) => (t.g.logLevel = 'none')) },
  { name: 'log-level', mode: G, args: ['level'], support: 'yes', desc: 'Set log level to: none, error, warn or info', apply: set((t, v) => (t.g.logLevel = v), logLevel) },
  { name: 'no-collate', mode: G, args: [], support: 'yes', desc: 'Do not collate copies', apply: flag((t) => (t.g.collate = false)) },
  { name: 'collate', mode: G, args: [], support: 'yes', desc: 'Collate copies', apply: flag((t) => (t.g.collate = true)) },
  { name: 'copies', mode: G, args: ['number'], support: 'yes', desc: 'Number of copies in the PDF', apply: set((t, v) => (t.g.copies = v), int) },
  { name: 'orientation', short: 'O', mode: G, args: ['orientation'], support: 'yes', desc: 'Set orientation to Landscape or Portrait', apply: set((t, v) => (t.g.orientation = v), orientation) },
  { name: 'page-size', short: 's', mode: G, args: ['size'], support: 'yes', desc: 'Set paper size: A4, Letter...', apply: set((t, v) => (t.g.pageSize = v), strToPageSize) },
  { name: 'grayscale', short: 'g', mode: G, args: [], support: 'yes', desc: 'Render in grayscale', apply: flag((t) => (t.g.grayscale = true)) },
  { name: 'lowquality', short: 'l', mode: G, args: [], support: 'silent', desc: 'Accepted, no effect', apply: flag((t) => (t.g.lowquality = true)) },
  { name: 'title', mode: G, args: ['text'], support: 'yes', desc: 'Document title (default: title of the first page)', apply: set((t, v) => (t.g.documentTitle = v), str) },
  { name: 'read-args-from-stdin', mode: G, args: [], support: 'yes', desc: 'Read one command line per line of the standard input', apply: flag((t) => (t.g.readArgsFromStdin = true)) },
  { name: 'margin-bottom', short: 'B', mode: G, args: ['unitreal'], support: 'yes', desc: 'Bottom margin', apply: set((t, v) => (t.g.margin.bottom = v), unit) },
  { name: 'margin-left', short: 'L', mode: G, args: ['unitreal'], support: 'yes', desc: 'Left margin (default 10mm)', apply: set((t, v) => (t.g.margin.left = v), unit) },
  { name: 'margin-right', short: 'R', mode: G, args: ['unitreal'], support: 'yes', desc: 'Right margin (default 10mm)', apply: set((t, v) => (t.g.margin.right = v), unit) },
  { name: 'margin-top', short: 'T', mode: G, args: ['unitreal'], support: 'yes', desc: 'Top margin', apply: set((t, v) => (t.g.margin.top = v), unit) },
  { name: 'dpi', short: 'd', mode: G, args: ['dpi'], support: 'yes', desc: 'Resolution of lengths in pixels and of automatic header and footer margins (default 96)', apply: set((t, v) => (t.g.dpi = v), int) },
  { name: 'page-height', mode: G, args: ['unitreal'], support: 'yes', desc: 'Page height', apply: set((t, v) => (t.g.pageHeight = v), unit) },
  { name: 'page-width', mode: G, args: ['unitreal'], support: 'yes', desc: 'Page width', apply: set((t, v) => (t.g.pageWidth = v), unit) },
  { name: 'cookie-jar', mode: G, args: ['path'], support: 'yes', desc: 'Read and write cookies from and to this file', apply: set((t, v) => (t.g.cookieJar = v), str) },
  { name: 'image-quality', mode: G, args: ['integer'], support: 'noop', desc: 'Accepted, no effect', apply: set((t, v) => (t.g.imageQuality = v), int) },
  { name: 'image-dpi', mode: G, args: ['integer'], support: 'noop', desc: 'Accepted, no effect', apply: set((t, v) => (t.g.imageDPI = v), int) },
  { name: 'no-pdf-compression', mode: G, args: [], support: 'noop', desc: 'Accepted, no effect', apply: flag((t) => (t.g.useCompression = false)) },
  { name: 'use-xserver', mode: G, args: [], support: 'noop', desc: 'Accepted, no effect', apply: flag((t) => (t.g.useGraphics = true)) },
  // Outline options.
  { name: 'outline', mode: G, args: [], support: 'yes', desc: 'Add an outline (default)', apply: flag((t) => (t.g.outline = true)) },
  { name: 'no-outline', mode: G, args: [], support: 'yes', desc: 'Do not add an outline', apply: flag((t) => (t.g.outline = false)) },
  { name: 'outline-depth', mode: G, args: ['level'], support: 'yes', desc: 'Depth of the outline (default 4)', apply: set((t, v) => (t.g.outlineDepth = v), int) },
  { name: 'dump-outline', mode: G, args: ['file'], support: 'yes', desc: 'Dump the outline to a file', apply: set((t, v) => (t.g.dumpOutline = v), str) },
  { name: 'dump-default-toc-xsl', mode: G, args: [], support: 'yes', desc: 'Dump the default TOC style sheet', action: 'dump-default-toc-xsl' },
  // Page options.
  {
    name: 'default-header', mode: P, args: [], support: 'yes', desc: 'Page name on the left, page number on the right, top margin 2cm',
    apply: flag((t) => {
      t.o.header.left = '[webpage]';
      t.o.header.right = '[page]/[topage]';
      t.o.header.line = true;
      t.g.margin.top = { value: 20, unit: 'mm' };
    }),
  },
  { name: 'viewport-size', mode: P, args: ['size'], support: 'yes', desc: 'Viewport size, WIDTHxHEIGHT, for media queries', apply: set((t, v) => (t.g.viewportSize = v), str) },
  { name: 'enable-plugins', mode: P, args: [], support: 'noop', desc: 'Accepted, no effect', apply: flag((t) => (t.o.web.enablePlugins = true)) },
  { name: 'disable-plugins', mode: P, args: [], support: 'silent', desc: 'Accepted, no effect (default)', apply: flag((t) => (t.o.web.enablePlugins = false)) },
  { name: 'minimum-font-size', mode: P, args: ['int'], support: 'yes', desc: 'Minimum font size', apply: set((t, v) => (t.o.web.minimumFontSize = v), int) },
  { name: 'user-style-sheet', mode: P, args: ['path'], support: 'yes', desc: 'Style sheet loaded with every page', apply: set((t, v) => (t.o.web.userStyleSheet = v), str) },
  { name: 'no-images', mode: P, args: [], support: 'yes', desc: 'Do not load or print images', apply: flag((t) => (t.o.web.loadImages = false)) },
  { name: 'images', mode: P, args: [], support: 'yes', desc: 'Load and print images (default)', apply: flag((t) => (t.o.web.loadImages = true)) },
  { name: 'disable-javascript', short: 'n', mode: P, args: [], support: 'yes', desc: 'Do not run JavaScript', apply: flag((t) => (t.o.web.enableJavascript = false)) },
  { name: 'enable-javascript', mode: P, args: [], support: 'yes', desc: 'Run JavaScript (default)', apply: flag((t) => (t.o.web.enableJavascript = true)) },
  { name: 'encoding', mode: P, args: ['encoding'], support: 'yes', desc: 'Default text encoding of the input', apply: set((t, v) => (t.o.web.defaultEncoding = v), str) },
  { name: 'no-background', mode: P, args: [], support: 'yes', desc: 'Do not print backgrounds', apply: flag((t) => (t.o.web.background = false)) },
  { name: 'background', mode: P, args: [], support: 'yes', desc: 'Print backgrounds (default)', apply: flag((t) => (t.o.web.background = true)) },
  { name: 'include-in-outline', mode: P, args: [], support: 'yes', desc: 'Include the page in the outline (default)', apply: flag((t) => (t.o.includeInOutline = true)) },
  { name: 'exclude-from-outline', mode: P, args: [], support: 'yes', desc: 'Leave the page out of the outline', apply: flag((t) => (t.o.includeInOutline = false)) },
  { name: 'disable-smart-shrinking', mode: P, args: [], support: 'yes', desc: "Chromium's natural scale instead of WebKit's shrinking", apply: flag((t) => (t.o.web.enableIntelligentShrinking = false)) },
  { name: 'enable-smart-shrinking', mode: P, args: [], support: 'yes', desc: "WebKit's shrinking, scale 0.8 (default)", apply: flag((t) => (t.o.web.enableIntelligentShrinking = true)) },
  { name: 'print-media-type', mode: P, args: [], support: 'yes', desc: 'Use the print media type instead of screen', apply: flag((t) => (t.o.web.printMediaType = true)) },
  { name: 'no-print-media-type', mode: P, args: [], support: 'yes', desc: 'Use the screen media type (default)', apply: flag((t) => (t.o.web.printMediaType = false)) },
  { name: 'enable-forms', mode: P, args: [], support: 'noop', desc: 'Accepted, no effect', apply: flag((t) => (t.o.produceForms = true)) },
  { name: 'disable-forms', mode: P, args: [], support: 'silent', desc: 'Accepted, no effect (default)', apply: flag((t) => (t.o.produceForms = false)) },
  { name: 'disable-internal-links', mode: P, args: [], support: 'yes', desc: 'Do not make internal links', apply: flag((t) => (t.o.useLocalLinks = false)) },
  { name: 'enable-internal-links', mode: P, args: [], support: 'silent', desc: 'Make internal links (default)', apply: flag((t) => (t.o.useLocalLinks = true)) },
  { name: 'disable-external-links', mode: P, args: [], support: 'yes', desc: 'Do not make links to web pages', apply: flag((t) => (t.o.useExternalLinks = false)) },
  { name: 'enable-external-links', mode: P, args: [], support: 'silent', desc: 'Make links to web pages (default)', apply: flag((t) => (t.o.useExternalLinks = true)) },
  { name: 'resolve-relative-links', mode: P, args: [], support: 'silent', desc: 'Make relative links absolute (default)', apply: flag((t) => (t.g.resolveRelativeLinks = true)) },
  { name: 'keep-relative-links', mode: P, args: [], support: 'yes', desc: 'Keep relative links relative', apply: flag((t) => (t.g.resolveRelativeLinks = false)) },
  { name: 'enable-toc-back-links', mode: P, args: [], support: 'yes', desc: 'Link headings back to the TOC', apply: flag((t) => (t.o.toc.backLinks = true)) },
  { name: 'disable-toc-back-links', mode: P, args: [], support: 'silent', desc: 'No links back to the TOC (default)', apply: flag((t) => (t.o.toc.backLinks = false)) },
  {
    name: 'proxy', short: 'p', mode: P, args: ['proxy'], support: 'yes', desc: 'Use a proxy: [http://|socks5://][user[:password]@]host[:port], or none',
    apply: (t, a) => {
      const p = strToProxy(a[0]!);
      if (p === undefined) return false;
      t.o.load.proxy = p;
      return true;
    },
  },
  { name: 'proxy-hostname-lookup', mode: P, args: [], support: 'noop', desc: 'Accepted, no effect', apply: flag((t) => (t.o.load.proxyHostNameLookup = true)) },
  { name: 'bypass-proxy-for', mode: P, args: ['value'], support: 'yes', desc: 'Do not use the proxy for this host (repeatable)', apply: (t, a) => (t.o.load.bypassProxyForHosts.push(a[0]!), true) },
  { name: 'username', mode: P, args: ['username'], support: 'yes', desc: 'HTTP authentication user name', apply: set((t, v) => (t.o.load.username = v), str) },
  { name: 'password', mode: P, args: ['password'], support: 'yes', desc: 'HTTP authentication password', apply: set((t, v) => (t.o.load.password = v), str) },
  { name: 'ssl-key-path', mode: P, args: ['path'], support: 'yes', desc: 'Client certificate private key, PEM', apply: set((t, v) => (t.o.load.clientSslKeyPath = v), str) },
  { name: 'ssl-key-password', mode: P, args: ['password'], support: 'yes', desc: 'Password of the client certificate key', apply: set((t, v) => (t.o.load.clientSslKeyPassword = v), str) },
  { name: 'ssl-crt-path', mode: P, args: ['path'], support: 'yes', desc: 'Client certificate, PEM', apply: set((t, v) => (t.o.load.clientSslCrtPath = v), str) },
  { name: 'load-error-handling', mode: P, args: ['handler'], support: 'yes', desc: 'Pages that fail to load: abort, ignore or skip', apply: set((t, v) => (t.o.load.loadErrorHandling = v), handling) },
  { name: 'load-media-error-handling', mode: P, args: ['handler'], support: 'yes', desc: 'Media that fail to load: abort, ignore or skip', apply: set((t, v) => (t.o.load.mediaLoadErrorHandling = v), handling) },
  { name: 'custom-header', mode: P, args: ['name', 'value'], support: 'yes', desc: 'Add an HTTP header (repeatable)', apply: (t, a) => (t.o.load.customHeaders.push([a[0]!, a[1]!]), true) },
  { name: 'custom-header-propagation', mode: P, args: [], support: 'yes', desc: 'Send --custom-header with every request', apply: flag((t) => (t.o.load.repeatCustomHeaders = true)) },
  // wkhtmltopdf 0.12.6 sets propagation here too, a mistake in its code
  // that callers rely on without knowing: kept.
  { name: 'no-custom-header-propagation', mode: P, args: [], support: 'yes', desc: 'Same as --custom-header-propagation, as in wkhtmltopdf 0.12.6', apply: flag((t) => (t.o.load.repeatCustomHeaders = true)) },
  { name: 'javascript-delay', mode: P, args: ['msec'], support: 'yes', desc: 'Wait up to this long after loading (default 200), less once nothing can change the page', apply: set((t, v) => (t.o.load.jsdelay = v), int) },
  { name: 'window-status', mode: P, args: ['windowStatus'], support: 'yes', desc: 'Wait until window.status equals this string', apply: set((t, v) => (t.o.load.windowStatus = v), str) },
  { name: 'zoom', mode: P, args: ['float'], support: 'yes', desc: 'Zoom factor', apply: set((t, v) => (t.o.load.zoomFactor = v), float) },
  { name: 'cookie', mode: P, args: ['name', 'value'], support: 'yes', desc: 'Add a cookie, URL-encoded (repeatable)', apply: (t, a) => (t.o.load.cookies.push([a[0]!, a[1]!]), true) },
  { name: 'post', mode: P, args: ['name', 'value'], support: 'yes', desc: 'Add a POST field (repeatable)', apply: (t, a) => (t.o.load.post.push({ name: a[0]!, value: a[1]!, file: false }), true) },
  { name: 'post-file', mode: P, args: ['name', 'path'], support: 'yes', desc: 'POST a file (repeatable)', apply: (t, a) => (t.o.load.post.push({ name: a[0]!, value: a[1]!, file: true }), true) },
  { name: 'disable-local-file-access', mode: P, args: [], support: 'yes', desc: 'Local pages may not read other local files, except --allow (default)', apply: flag((t) => (t.o.load.blockLocalFileAccess = true)) },
  { name: 'enable-local-file-access', mode: P, args: [], support: 'yes', desc: 'Local pages may read other local files', apply: flag((t) => (t.o.load.blockLocalFileAccess = false)) },
  { name: 'allow', mode: P, args: ['path'], support: 'yes', desc: 'Allow the files of this folder (repeatable)', apply: (t, a) => (t.o.load.allowed.push(a[0]!), true) },
  { name: 'cache-dir', mode: P, args: ['path'], support: 'noop', desc: 'Accepted, no effect', apply: set((t, v) => (t.o.load.cacheDir = v), str) },
  { name: 'debug-javascript', mode: P, args: [], support: 'noop', desc: 'Accepted, no effect', apply: flag((t) => (t.o.load.debugJavascript = true)) },
  { name: 'no-debug-javascript', mode: P, args: [], support: 'silent', desc: 'Accepted, no effect (default)', apply: flag((t) => (t.o.load.debugJavascript = false)) },
  { name: 'stop-slow-scripts', mode: P, args: [], support: 'silent', desc: 'Accepted; --kiln-timeout bounds the conversion', apply: flag((t) => (t.o.load.stopSlowScripts = true)) },
  { name: 'no-stop-slow-scripts', mode: P, args: [], support: 'silent', desc: 'Accepted; --kiln-timeout bounds the conversion', apply: flag((t) => (t.o.load.stopSlowScripts = false)) },
  { name: 'run-script', mode: P, args: ['js'], support: 'yes', desc: 'Run this JavaScript after loading (repeatable)', apply: (t, a) => (t.o.load.runScript.push(a[0]!), true) },
  { name: 'checkbox-svg', mode: P, args: ['path'], support: 'noop', desc: 'Accepted, no effect', apply: set((t, v) => (t.o.load.checkboxSvg = v), str) },
  { name: 'checkbox-checked-svg', mode: P, args: ['path'], support: 'noop', desc: 'Accepted, no effect', apply: set((t, v) => (t.o.load.checkboxCheckedSvg = v), str) },
  { name: 'radiobutton-svg', mode: P, args: ['path'], support: 'noop', desc: 'Accepted, no effect', apply: set((t, v) => (t.o.load.radiobuttonSvg = v), str) },
  { name: 'radiobutton-checked-svg', mode: P, args: ['path'], support: 'noop', desc: 'Accepted, no effect', apply: set((t, v) => (t.o.load.radiobuttonCheckedSvg = v), str) },
  { name: 'page-offset', mode: P, args: ['offset'], support: 'yes', desc: 'Number added to page numbers (default 0)', apply: set((t, v) => (t.g.pageOffset = v), int) },
  // Headers and footers.
  { name: 'footer-center', mode: P, args: ['text'], support: 'yes', desc: 'Centered footer text', apply: set((t, v) => (t.o.footer.center = v), str) },
  { name: 'footer-font-name', mode: P, args: ['name'], support: 'yes', desc: 'Footer font (default Arial)', apply: set((t, v) => (t.o.footer.fontName = v), str) },
  { name: 'footer-font-size', mode: P, args: ['size'], support: 'yes', desc: 'Footer font size (default 12)', apply: set((t, v) => (t.o.footer.fontSize = v), int) },
  { name: 'footer-left', mode: P, args: ['text'], support: 'yes', desc: 'Left footer text', apply: set((t, v) => (t.o.footer.left = v), str) },
  { name: 'footer-line', mode: P, args: [], support: 'yes', desc: 'Line above the footer', apply: flag((t) => (t.o.footer.line = true)) },
  { name: 'no-footer-line', mode: P, args: [], support: 'yes', desc: 'No line above the footer (default)', apply: flag((t) => (t.o.footer.line = false)) },
  { name: 'footer-right', mode: P, args: ['text'], support: 'yes', desc: 'Right footer text', apply: set((t, v) => (t.o.footer.right = v), str) },
  { name: 'footer-spacing', mode: P, args: ['real'], support: 'yes', desc: 'Space between footer and content, mm', apply: set((t, v) => (t.o.footer.spacing = v), float) },
  { name: 'footer-html', mode: P, args: ['url'], support: 'yes', desc: 'HTML footer', apply: set((t, v) => (t.o.footer.htmlUrl = v), str) },
  { name: 'header-center', mode: P, args: ['text'], support: 'yes', desc: 'Centered header text', apply: set((t, v) => (t.o.header.center = v), str) },
  { name: 'header-font-name', mode: P, args: ['name'], support: 'yes', desc: 'Header font (default Arial)', apply: set((t, v) => (t.o.header.fontName = v), str) },
  { name: 'header-font-size', mode: P, args: ['size'], support: 'yes', desc: 'Header font size (default 12)', apply: set((t, v) => (t.o.header.fontSize = v), int) },
  { name: 'header-left', mode: P, args: ['text'], support: 'yes', desc: 'Left header text', apply: set((t, v) => (t.o.header.left = v), str) },
  { name: 'header-line', mode: P, args: [], support: 'yes', desc: 'Line below the header', apply: flag((t) => (t.o.header.line = true)) },
  { name: 'no-header-line', mode: P, args: [], support: 'yes', desc: 'No line below the header (default)', apply: flag((t) => (t.o.header.line = false)) },
  { name: 'header-right', mode: P, args: ['text'], support: 'yes', desc: 'Right header text', apply: set((t, v) => (t.o.header.right = v), str) },
  { name: 'header-spacing', mode: P, args: ['real'], support: 'yes', desc: 'Space between header and content, mm', apply: set((t, v) => (t.o.header.spacing = v), float) },
  { name: 'header-html', mode: P, args: ['url'], support: 'yes', desc: 'HTML header', apply: set((t, v) => (t.o.header.htmlUrl = v), str) },
  { name: 'replace', mode: P, args: ['name', 'value'], support: 'yes', desc: 'Replace [name] by value in headers and footers (repeatable)', apply: (t, a) => (t.o.replacements.push([a[0]!, a[1]!]), true) },
  // Table of contents.
  { name: 'xsl-style-sheet', mode: T, args: ['file'], support: 'yes', desc: 'XSL style sheet of the TOC', apply: set((t, v) => (t.o.tocXsl = v), str) },
  { name: 'toc-header-text', mode: T, args: ['text'], support: 'yes', desc: 'Title of the TOC', apply: set((t, v) => (t.o.toc.captionText = v), str) },
  { name: 'disable-toc-links', mode: T, args: [], support: 'yes', desc: 'No links from the TOC', apply: flag((t) => (t.o.toc.forwardLinks = false)) },
  { name: 'disable-dotted-lines', mode: T, args: [], support: 'yes', desc: 'No dotted lines in the TOC', apply: flag((t) => (t.o.toc.useDottedLines = false)) },
  { name: 'toc-text-size-shrink', mode: T, args: ['real'], support: 'yes', desc: 'Font scale per TOC level', apply: set((t, v) => (t.o.toc.fontScale = v), float) },
  { name: 'toc-level-indentation', mode: T, args: ['width'], support: 'yes', desc: 'Indentation per TOC level', apply: set((t, v) => (t.o.toc.indentation = v), str) },
];

// Ours. Never a name wkhtmltopdf has or could have.
export const KILN_OPTIONS: OptionSpec[] = [
  {
    name: 'kiln-timeout', mode: G, args: ['seconds'], support: 'yes', desc: 'Stop the conversion and Chromium after this many seconds (default 120, 0: none)',
    apply: set<number>((t, v) => (t.g.kiln.timeout = v), (s) => {
      const n = strToFloat(s);
      return n !== null && n >= 0 ? n : null;
    }),
  },
  { name: 'kiln-block-private-network', mode: G, args: [], support: 'yes', desc: 'Refuse loopback, private and link-local addresses', apply: flag((t) => (t.g.kiln.blockPrivateNetwork = true)) },
  { name: 'kiln-no-sandbox', mode: G, args: [], support: 'yes', desc: "Run Chromium without its sandbox (not recommended)", apply: flag((t) => (t.g.kiln.noSandbox = true)) },
];

// Ours, for a PDF only: wkhtmltoimage does not take them. Their values are
// checked before the render, with the reason when one is refused
// (src/pdf/archive.ts), not here, where wkhtmltopdf's message would only say
// "Invalid argument(s)".
export const KILN_PDF_OPTIONS: OptionSpec[] = [
  { name: 'kiln-pdfa', mode: G, args: ['level'], support: 'yes', desc: 'PDF/A for archiving: 2b, 2u, 3b or 3u', apply: set((t, v) => (t.g.kiln.pdfa = v), str) },
  { name: 'kiln-factur-x', mode: G, args: ['invoice.xml'], support: 'yes', desc: "Attach the invoice's CII XML: a Factur-X or ZUGFeRD invoice, in PDF/A-3", apply: set((t, v) => (t.g.kiln.facturX = v), str) },
];

export const ALL_OPTIONS = [...OPTIONS, ...KILN_OPTIONS, ...KILN_PDF_OPTIONS];
export const byLong = new Map(ALL_OPTIONS.map((o) => [o.name, o]));
export const byShort = new Map(ALL_OPTIONS.filter((o) => o.short).map((o) => [o.short!, o]));
