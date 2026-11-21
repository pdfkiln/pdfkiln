// wkhtmltoimage 0.12.6 (src/image, src/lib/imageconverter.cc): its
// options, its command line, and its rendering, a capture of the page by
// Chromium at the screen's width and the height of the content.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeQuietly } from '../engine/browser.js';
import { emulate, openPage } from '../engine/loader.js';
import { decodePng, toBmp, toPpm, toSvg, toXbm, toXpm } from '../engine/raster.js';
import { chromiumVersion, version } from '../version.js';
import { Chromium, loadJar, saveJar } from './chromium.js';
import { QtJar } from './cookiejar.js';
import { readStyleSheet, type Io, type Result } from './convert.js';
import type { Feedback } from './feedback.js';
import { KILN_OPTIONS, OPTIONS, type OptionSpec, type Target } from './options.js';
import { ActionRequest, UsageError } from './parse.js';
import { defaultGlobal, defaultObject } from './settings.js';
import { strToInt } from './units.js';
import { guessUrlFromString } from './urls.js';

export interface ImageSettings {
  in: string;
  out: string;
  fmt: string;
  quality: number;
  screenWidth: number;
  screenHeight: number;
  crop: { left: number; top: number; width: number; height: number };
  smartWidth: boolean;
  transparent: boolean;
}

export interface ImageTarget extends Target { img: ImageSettings }

export interface ImageParsed extends ImageTarget { used: OptionSpec[] }

const defaultImage = (): ImageSettings => ({
  in: '',
  out: '',
  fmt: '',
  quality: 94,
  screenWidth: 1024,
  screenHeight: 0,
  crop: { left: -1, top: -1, width: -1, height: -1 },
  smartWidth: true,
  transparent: false,
});

// The options both commands have, from the table of wkhtmltopdf
// (src/shared/commonarguments.cc: doc, web, global and page load options).
const SHARED = [
  'help', 'version', 'license', 'extended-help', 'manpage', 'htmldoc', 'readme',
  'enable-plugins', 'disable-plugins', 'minimum-font-size', 'user-style-sheet', 'no-images', 'images',
  'disable-javascript', 'enable-javascript', 'encoding', 'cookie-jar',
  'proxy', 'proxy-hostname-lookup', 'bypass-proxy-for', 'username', 'password', 'ssl-key-path', 'ssl-key-password', 'ssl-crt-path',
  'load-error-handling', 'load-media-error-handling', 'custom-header', 'custom-header-propagation', 'no-custom-header-propagation',
  'javascript-delay', 'window-status', 'zoom', 'cookie', 'post', 'post-file',
  'disable-local-file-access', 'enable-local-file-access', 'allow', 'cache-dir', 'debug-javascript', 'no-debug-javascript',
  'stop-slow-scripts', 'no-stop-slow-scripts', 'run-script', 'checkbox-svg', 'checkbox-checked-svg', 'radiobutton-svg', 'radiobutton-checked-svg',
  'quiet', 'log-level', 'use-xserver',
];

const img = <T>(f: (s: ImageSettings, v: T) => void, parse: (s: string) => T | null) => (t: Target, a: string[]) => {
  const v = parse(a[0]!);
  if (v === null) return false;
  f((t as ImageTarget).img, v);
  return true;
};
const flag = (f: (s: ImageSettings) => void) => (t: Target) => {
  f((t as ImageTarget).img);
  return true;
};
const G = 'global' as const;

// src/image/imagearguments.cc.
export const IMAGE_OPTIONS: OptionSpec[] = [
  ...SHARED.map((n) => OPTIONS.find((o) => o.name === n)!),
  { name: 'width', mode: G, args: ['int'], support: 'yes', desc: 'Screen width (default 1024), widened to fit the content unless --disable-smart-width', apply: img((s, v) => (s.screenWidth = v), strToInt) },
  { name: 'height', mode: G, args: ['int'], support: 'yes', desc: 'Screen height (default: the height of the content)', apply: img((s, v) => (s.screenHeight = v), strToInt) },
  { name: 'crop-x', mode: G, args: ['int'], support: 'yes', desc: 'Left of the cropped area', apply: img((s, v) => (s.crop.left = v), strToInt) },
  { name: 'crop-y', mode: G, args: ['int'], support: 'yes', desc: 'Top of the cropped area', apply: img((s, v) => (s.crop.top = v), strToInt) },
  { name: 'crop-w', mode: G, args: ['int'], support: 'yes', desc: 'Width of the cropped area', apply: img((s, v) => (s.crop.width = v), strToInt) },
  { name: 'crop-h', mode: G, args: ['int'], support: 'yes', desc: 'Height of the cropped area', apply: img((s, v) => (s.crop.height = v), strToInt) },
  { name: 'format', short: 'f', mode: G, args: ['format'], support: 'yes', desc: 'jpg, png, bmp, ppm, xpm, xbm or svg (default: the extension of the output, jpg for -)', apply: img((s, v) => (s.fmt = v), (v: string) => v) },
  { name: 'quality', mode: G, args: ['int'], support: 'yes', desc: 'JPEG quality, 0 to 100 (default 94)', apply: img((s, v) => (s.quality = v), strToInt) },
  { name: 'disable-smart-width', mode: G, args: [], support: 'yes', desc: 'Keep --width even if the content is wider', apply: flag((s) => (s.smartWidth = false)) },
  { name: 'enable-smart-width', mode: G, args: [], support: 'yes', desc: 'Widen --width to fit the content (default)', apply: flag((s) => (s.smartWidth = true)) },
  { name: 'transparent', mode: G, args: [], support: 'yes', desc: 'Transparent background, in PNG and SVG', apply: flag((s) => (s.transparent = true)) },
];

const ALL = [...IMAGE_OPTIONS, ...KILN_OPTIONS];
const byLong = new Map(ALL.map((o) => [o.name, o]));
const byShort = new Map(ALL.filter((o) => o.short).map((o) => [o.short!, o]));

// src/image/imagecommandlineparser.cc parseArguments: the last two
// arguments that are not options are the input and the output; every
// option is global.
export function parseImageArguments(argv: string[]): ImageParsed {
  const t: ImageParsed = { g: defaultGlobal(), o: defaultObject(), img: defaultImage(), used: [] };
  const argc = argv.length;
  const notOption = (a: string) => a[0] !== '-' || a.length === 1;
  let defaultMode = false;
  for (let i = 1; i < argc; ++i) {
    const a = argv[i]!;
    if (i === argc - 2 && notOption(a)) t.img.in = a;
    else if (i === argc - 1 && notOption(a)) t.img.out = a;
    else {
      if (defaultMode || !a.startsWith('-') || a.length < 2) throw new UsageError(`Unknown long argument ${a}`);
      const run = (spec: OptionSpec, label: string) => {
        if (argc - i < spec.args.length + 1) throw new UsageError(`Not enough arguments parsed to ${label}`);
        if (spec.action) throw new ActionRequest(spec.action);
        if (!spec.apply!(t, argv.slice(i + 1, i + 1 + spec.args.length))) throw new UsageError(`Invalid argument(s) parsed to ${label}`);
        t.used.push(spec);
        return spec.args.length;
      };
      if (a[1] === '-') {
        if (a[2] === '0') {
          defaultMode = true;
          continue;
        }
        const spec = byLong.get(a.slice(2));
        if (!spec) throw new UsageError(`Unknown long argument ${a}`);
        i += run(spec, a);
      } else {
        let skip = 0;
        for (const ch of a.slice(1)) {
          const spec = byShort.get(ch);
          if (!spec) throw new UsageError(`Unknown switch -${ch}`);
          skip += run(spec, `-${ch}`);
        }
        i += skip;
      }
    }
  }
  if (!t.img.in || !t.img.out) throw new UsageError('You need to specify at least one input file, and exactly one output file\nUse - for stdin or stdout');
  return t;
}

export function imageVersionLine(): string {
  return `wkhtmltoimage 0.12.6 (with patched qt), pdfkiln ${version}, Chromium ${chromiumVersion}`;
}

export function imageUsage(): string {
  const line = (o: OptionSpec) => `  ${`${o.short ? `-${o.short}, ` : '    '}--${o.name}${o.args.map((a) => ` <${a}>`).join('')}`.padEnd(44)} ${o.desc}`;
  return [
    'Name:',
    `  ${imageVersionLine()}`,
    '',
    'Synopsis:',
    '  wkhtmltoimage [OPTIONS]... <input file> <output file>',
    '',
    'The input is a file, a URL, or - for the standard input; the output a file, or - for',
    'the standard output. pdfkiln renders with Chromium and reproduces wkhtmltoimage 0.12.6:',
    'its options, its defaults, its messages and its exit codes.',
    '',
    'General options:',
    ...[...ALL].sort((a, b) => a.name.localeCompare(b.name)).map(line),
    '',
    'pdfkiln is not affiliated with the wkhtmltopdf project.',
    '',
  ].join('\n');
}

const SUPPORTED = new Set(['jpg', 'jpeg', 'png', 'bmp', 'ppm', 'xpm', 'xbm']);

export async function convertImage(p: ImageParsed, fb: Feedback, io: Io): Promise<Result> {
  const { g, o, img: s } = p;
  const fail = (errorCode = 0): Result => ({ success: false, errorCode });
  for (const spec of new Set(p.used)) {
    if (spec.support === 'noop') fb.warning(`--${spec.name} has no effect with pdfkiln`);
  }
  if (g.kiln.noSandbox) fb.warning("Chromium's sandbox is off (--kiln-no-sandbox)");
  const work = mkdtempSync(join(tmpdir(), 'pdfkiln-'));
  const chromium = new Chromium();
  try {
    fb.phaseChanged(0);
    fb.progressChanged(0, '0%');
    const block = g.kiln.blockPrivateNetwork;
    const context = await chromium.start(g, o.load.proxy, o.load.bypassProxyForHosts, work, fb, io.onTimeout);
    const jar = new QtJar();
    if (g.cookieJar) await loadJar(context, g.cookieJar, jar);
    let url = guessUrlFromString(s.in);
    if (s.in === '-') {
      const file = join(work, 'stdin.html');
      writeFileSync(file, io.stdin());
      url = pathToFileURL(file).href;
    }
    const width = Math.max(1, s.screenWidth);
    const l = await openPage(context, {
      url,
      web: o.web,
      load: o.load,
      isMain: true,
      media: 'screen',
      viewport: { width, height: 10 },
      emulation: { roundFontSizes: true, minimumFontSize: o.web.minimumFontSize > 0 ? o.web.minimumFontSize : 0, webkit534Css: true },
      fontFamilies: chromium.fontFamilies,
      blockPrivateNetwork: block,
      ignoreCertificateErrors: !g.kiln.blockInvalidCertificates,
      proxy: chromium.upstream,
      qtCookies: jar,
      ...(o.web.userStyleSheet ? await readStyleSheet(o.web.userStyleSheet).then((u) => ({ userStyleSheet: u.css, userStyleSheetUrl: u.url })) : {}),
    }, fb);
    fb.progressChanged(100, '100%');
    if (g.cookieJar) await saveJar(l, g.cookieJar, jar);
    const errorCode = l.errorCode;
    if (!l.ok && o.load.loadErrorHandling === 'abort') return fail(errorCode);

    // pagesLoaded: the format, the width, the height.
    const fmt = s.fmt || (s.out === '-' ? 'jpg' : (s.out.match(/\.([^./\\]*)$/)?.[1] ?? ''));
    fb.phaseChanged(1);
    fb.progressChanged(0, '0%');
    await emulate(l);
    if (o.load.zoomFactor !== 1) await l.page.evaluate((z: number) => document.documentElement.style.setProperty('zoom', String(z)), o.load.zoomFactor);
    fb.progressChanged(25, '25%');
    const setViewport = (w: number, h: number) => l.page.setViewport({ width: w, height: Math.max(1, h) });
    const overflows = () => l.page.evaluate(() => {
      const e = document.scrollingElement ?? document.documentElement;
      return e.scrollWidth > window.innerWidth;
    });
    let high = width;
    await setViewport(high, 10);
    if (s.smartWidth && await overflows()) {
      high = Math.max(high, 10);
      let low = high;
      while (await overflows() && high < 32000) {
        low = high;
        high *= 2;
        await setViewport(high, 10);
      }
      while (high - low > 10) {
        const t = low + Math.floor((high - low) / 2);
        await setViewport(t, 10);
        if (await overflows()) low = t;
        else high = t;
      }
    }
    const height = s.screenHeight > 0
      ? s.screenHeight
      : await l.page.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollHeight);
    await setViewport(high, height);

    if (s.out !== '-') {
      try {
        writeFileSync(s.out, '');
      } catch {
        fb.error('Could not write to output file');
        return fail(errorCode);
      }
    }
    const crop = {
      left: Math.max(0, s.crop.left),
      top: Math.max(0, s.crop.top),
      width: s.crop.width < 0 ? 1000000 : s.crop.width,
      height: s.crop.height < 0 ? 1000000 : s.crop.height,
    };
    const x = Math.min(crop.left, high);
    const y = Math.min(crop.top, height);
    const rect = { x, y, width: Math.max(0, Math.min(high, crop.left + crop.width) - x), height: Math.max(0, Math.min(height, crop.top + crop.height) - y) };
    if (rect.width === 0 || rect.height === 0) {
      fb.error('Will not output an empty image');
      return fail(errorCode);
    }
    const lower = fmt.toLowerCase();
    const transparent = s.transparent && (lower === 'png' || fmt === 'svg');
    if (transparent) {
      await l.page.evaluate(() => {
        document.body?.style.setProperty('background-color', 'transparent');
        document.body?.style.setProperty('background-image', 'none');
      });
    }
    const jpeg = lower === 'jpg' || lower === 'jpeg';
    let bytes: Buffer | null = null;
    if (fmt === 'svg' || SUPPORTED.has(lower)) {
      const shot = Buffer.from(await l.page.screenshot({
        type: jpeg ? 'jpeg' : 'png',
        quality: jpeg ? Math.min(100, Math.max(0, s.quality)) : undefined,
        clip: rect,
        omitBackground: transparent,
      }));
      if (jpeg || lower === 'png') bytes = shot;
      else if (fmt === 'svg') bytes = toSvg(shot, rect.width, rect.height);
      else {
        const r = decodePng(shot);
        bytes = lower === 'bmp' ? toBmp(r) : lower === 'ppm' ? toPpm(r) : lower === 'xpm' ? toXpm(r) : toXbm(r);
      }
    }
    if (!bytes) {
      fb.error('Could not save image');
      return fail(errorCode);
    }
    if (s.out === '-') io.stdout(bytes);
    else writeFileSync(s.out, bytes);
    fb.progressChanged(100, '100%');
    fb.phaseChanged(2);
    return { success: true, errorCode };
  } finally {
    await chromium.close();
    removeQuietly(work);
  }
}
