// Settings of the wkhtmltopdf-compatible mode, with the defaults of
// wkhtmltopdf 0.12.6 (src/lib/pdfsettings.cc, loadsettings.cc,
// websettings.cc). Names follow wkhtmltopdf's so that the code can be read
// side by side with it.

export type Unit = 'mm' | 'inch' | 'pica' | 'didot' | 'cicero' | 'px' | 'pt';

// A length as wkhtmltopdf keeps it: a number and its unit. -1 means unset.
export interface UnitReal { value: number; unit: Unit }

export type LogLevel = 'none' | 'error' | 'warn' | 'info';
export const LOG_LEVELS: LogLevel[] = ['none', 'error', 'warn', 'info'];

export type LoadErrorHandling = 'abort' | 'skip' | 'ignore';

export interface Proxy { type: 'http' | 'socks5'; host: string; port: number; user: string; password: string }

export interface HeaderFooter {
  fontSize: number;
  fontName: string;
  left: string;
  right: string;
  center: string;
  line: boolean;
  htmlUrl: string;
  spacing: number; // mm
}

export interface Web {
  background: boolean;
  loadImages: boolean;
  enableJavascript: boolean;
  enableIntelligentShrinking: boolean;
  minimumFontSize: number; // -1: none
  printMediaType: boolean;
  defaultEncoding: string;
  userStyleSheet: string;
  enablePlugins: boolean;
}

export interface PostItem { name: string; value: string; file: boolean }

export interface LoadPage {
  username: string;
  password: string;
  proxy: Proxy | null; // null: no proxy ("none" or unset)
  proxyHostNameLookup: boolean;
  bypassProxyForHosts: string[];
  clientSslKeyPath: string;
  clientSslKeyPassword: string;
  clientSslCrtPath: string;
  loadErrorHandling: LoadErrorHandling;
  mediaLoadErrorHandling: LoadErrorHandling;
  customHeaders: [string, string][];
  repeatCustomHeaders: boolean;
  jsdelay: number; // ms
  windowStatus: string;
  zoomFactor: number;
  cookies: [string, string][];
  post: PostItem[];
  blockLocalFileAccess: boolean;
  allowed: string[];
  cacheDir: string;
  debugJavascript: boolean;
  stopSlowScripts: boolean;
  runScript: string[];
  checkboxSvg: string;
  checkboxCheckedSvg: string;
  radiobuttonSvg: string;
  radiobuttonCheckedSvg: string;
}

export interface TableOfContent {
  useDottedLines: boolean;
  captionText: string;
  forwardLinks: boolean;
  backLinks: boolean;
  indentation: string;
  fontScale: number;
}

export type ObjectKind = 'page' | 'cover' | 'toc';

export interface PdfObject {
  page: string;
  kind: ObjectKind;
  web: Web;
  load: LoadPage;
  header: HeaderFooter;
  footer: HeaderFooter;
  replacements: [string, string][];
  useExternalLinks: boolean;
  useLocalLinks: boolean;
  produceForms: boolean;
  includeInOutline: boolean;
  toc: TableOfContent;
  tocXsl: string;
}

// Options of our own, prefixed --kiln- in the compatible mode.
export interface Kiln {
  timeout: number; // seconds
  blockPrivateNetwork: boolean;
  noSandbox: boolean;
}

export interface PdfGlobal {
  logLevel: LogLevel;
  useGraphics: boolean;
  resolveRelativeLinks: boolean;
  orientation: 'Portrait' | 'Landscape';
  grayscale: boolean;
  lowquality: boolean;
  dpi: number;
  pageOffset: number;
  copies: number;
  collate: boolean;
  outline: boolean;
  outlineDepth: number;
  dumpOutline: string;
  out: string;
  documentTitle: string;
  useCompression: boolean;
  viewportSize: string;
  imageDPI: number;
  imageQuality: number;
  readArgsFromStdin: boolean;
  cookieJar: string;
  pageSize: string;
  pageWidth: UnitReal;
  pageHeight: UnitReal;
  margin: { top: UnitReal; right: UnitReal; bottom: UnitReal; left: UnitReal };
  kiln: Kiln;
}

const mm = (value: number): UnitReal => ({ value, unit: 'mm' });

export function defaultGlobal(): PdfGlobal {
  return {
    logLevel: 'info',
    useGraphics: false,
    resolveRelativeLinks: true,
    orientation: 'Portrait',
    grayscale: false,
    lowquality: false,
    dpi: 96,
    pageOffset: 0,
    copies: 1,
    collate: true,
    outline: true,
    outlineDepth: 4,
    dumpOutline: '',
    out: '',
    documentTitle: '',
    useCompression: true,
    viewportSize: '',
    imageDPI: 600,
    imageQuality: 94,
    readArgsFromStdin: false,
    cookieJar: '',
    pageSize: 'A4',
    pageWidth: mm(-1),
    pageHeight: mm(-1),
    // Top and bottom are unset: they become 10 mm, or are computed from
    // --header-html and --footer-html.
    margin: { top: mm(-1), right: mm(10), bottom: mm(-1), left: mm(10) },
    kiln: { timeout: 120, blockPrivateNetwork: false, noSandbox: false },
  };
}

function defaultHeaderFooter(): HeaderFooter {
  return { fontSize: 12, fontName: 'Arial', left: '', right: '', center: '', line: false, htmlUrl: '', spacing: 0 };
}

export function defaultObject(): PdfObject {
  return {
    page: '',
    kind: 'page',
    web: {
      background: true,
      loadImages: true,
      enableJavascript: true,
      enableIntelligentShrinking: true,
      minimumFontSize: -1,
      printMediaType: false,
      defaultEncoding: '',
      userStyleSheet: '',
      enablePlugins: false,
    },
    load: {
      username: '',
      password: '',
      proxy: null,
      proxyHostNameLookup: false,
      bypassProxyForHosts: [],
      clientSslKeyPath: '',
      clientSslKeyPassword: '',
      clientSslCrtPath: '',
      loadErrorHandling: 'abort',
      mediaLoadErrorHandling: 'ignore',
      customHeaders: [],
      repeatCustomHeaders: false,
      jsdelay: 200,
      windowStatus: '',
      zoomFactor: 1,
      cookies: [],
      post: [],
      blockLocalFileAccess: true,
      allowed: [],
      cacheDir: '',
      debugJavascript: false,
      stopSlowScripts: true,
      runScript: [],
      checkboxSvg: '',
      checkboxCheckedSvg: '',
      radiobuttonSvg: '',
      radiobuttonCheckedSvg: '',
    },
    header: defaultHeaderFooter(),
    footer: defaultHeaderFooter(),
    replacements: [],
    useExternalLinks: true,
    useLocalLinks: true,
    produceForms: false,
    includeInOutline: true,
    toc: {
      useDottedLines: true,
      captionText: 'Table of Contents',
      forwardLinks: true,
      backLinks: false,
      indentation: '1em',
      fontScale: 0.8,
    },
    tocXsl: '',
  };
}

// wkhtmltopdf copies the settings given before the first page into every
// page; structuredClone keeps the lists of each page apart.
export function cloneObject(o: PdfObject): PdfObject {
  return structuredClone(o);
}
