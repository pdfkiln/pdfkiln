// wkhtmltopdf's fonts. Its Qt's generic families are Times (standard and
// serif), Courier New, Helvetica, Comic Sans MS and Impact. On Linux, Qt
// takes a family only when it is installed, or the one WebKit pairs it
// with (Times and Times New Roman, Courier and Courier New, Helvetica and
// Arial); a page whose families are all missing gets the standard family,
// and when that one is missing too, Qt's last resort, what fontconfig
// gives for "Helvetica". Chromium is given a fontconfig setup without the
// substitution rules, and those families as they are installed.
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The family of each generic one, as Page.setFontFamilies takes them.
export interface GenericFamilies {
  standard: string;
  serif: string;
  sansSerif: string;
  fixed: string;
  cursive: string;
  fantasy: string;
  math: string;
}

export interface QtFonts {
  // Settles once fontconfig runs (true) or could not start (false).
  started: Promise<boolean>;
  families: Promise<GenericFamilies | undefined>;
}

// wkhtmltopdf's under Windows, whose fonts every Windows has.
const WINDOWS: GenericFamilies = {
  standard: 'Times New Roman', serif: 'Times New Roman', sansSerif: 'Arial', fixed: 'Courier New',
  cursive: 'Comic Sans MS', fantasy: 'Impact', math: 'Times New Roman',
};

// Qt's families on Linux, from those installed and the last resort: none
// without the standard family and the last resort. A generic family
// missing falls to the standard one; math is not one of Qt's.
export function qtFamilies(installed: string[], lastResort?: string): GenericFamilies | undefined {
  const byName = new Map(installed.map((f) => [f.toLowerCase(), f]));
  const find = (...names: string[]) => names.map((n) => byName.get(n.toLowerCase())).find((f) => f !== undefined);
  const standard = find('Times', 'Times New Roman') ?? lastResort;
  if (!standard) return undefined;
  return {
    standard, serif: standard, math: standard,
    sansSerif: find('Helvetica', 'Arial') ?? standard,
    fixed: find('Courier New', 'Courier') ?? standard,
    cursive: find('Comic Sans MS') ?? standard,
    fantasy: find('Impact') ?? standard,
  };
}

function command(file: string, args: string[]): { started: Promise<boolean>; out: Promise<string | undefined> } {
  let child!: ChildProcess;
  const out = new Promise<string | undefined>((resolve) => {
    child = execFile(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 << 20 }, (e, stdout) => resolve(e ? undefined : stdout));
  });
  const started = new Promise<boolean>((resolve) => {
    child.once('spawn', () => resolve(true));
    child.once('error', () => resolve(false));
  });
  return { started, out };
}

let qt: QtFonts | undefined;

// fontconfig, in the background: each command takes 0.25 s on a server with
// ten thousand fonts, which it spends while Chromium starts. fc-match only
// for the last resort, which Times or Times New Roman leave unused. Without
// its answer, Chromium keeps its own families.
export function qtFonts(): QtFonts {
  if (process.platform === 'win32') return { started: Promise.resolve(false), families: Promise.resolve(WINDOWS) };
  if (process.platform !== 'linux') return { started: Promise.resolve(false), families: Promise.resolve(undefined) };
  if (!qt) {
    // Qt knows a font by its first family name.
    const list = command('fc-list', ['-f', '%{family[0]}\n', ':', 'family']);
    const families = list.out.then(async (l) => {
      const installed = (l ?? '').split('\n').map((f) => f.trim()).filter(Boolean);
      return qtFamilies(installed) ?? qtFamilies(installed, (await command('fc-match', ['-f', '%{family[0]}', 'Helvetica']).out)?.trim());
    });
    qt = { started: list.started, families };
  }
  return qt;
}

function fontDirs(): string[] {
  const conf = process.env.FONTCONFIG_FILE;
  if (conf && existsSync(conf)) {
    const dirs = [...readFileSync(conf, 'utf8').matchAll(/<dir[^>]*>([^<]+)<\/dir>/g)].map((m) => m[1]!.trim());
    if (dirs.length) return dirs;
  }
  return ['/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.local', 'share', 'fonts'), join(homedir(), '.fonts')];
}

// Writes the setup in `dir` and returns the environment for Chromium.
export function noAliasEnv(dir: string): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return {};
  const file = join(dir, 'fonts.conf');
  const dirs = fontDirs().filter((d) => existsSync(d)).map((d) => `  <dir>${d.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</dir>`);
  writeFileSync(file, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
${dirs.join('\n')}
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
`);
  return { FONTCONFIG_FILE: file };
}
