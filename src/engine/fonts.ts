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
import { inflateSync } from 'node:zlib';

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

// The family Qt 4.8 draws a header or footer text in when none of its
// names is a font of the system: under fontconfig (Linux), the best match
// for the list, as fc-match gives it (DejaVu Sans on Debian and Ubuntu,
// where sans-serif, Qt's default, is Liberation Sans); under Windows, the
// face GDI falls back to, Tahoma (measured on 0.12.6). None elsewhere.
const fallbacks = new Map<string, Promise<string | undefined>>();
export function qtFallbackFamily(names: string[]): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve('Tahoma');
  if (process.platform !== 'linux' || !names.length) return Promise.resolve(undefined);
  // A fontconfig pattern: families parted by commas, the specials escaped.
  const pattern = names.map((n) => n.replace(/[\\:,-]/g, '\\$&')).join(',');
  let f = fallbacks.get(pattern);
  if (!f) {
    f = command('fc-match', ['-f', '%{family[0]}', pattern]).out.then((o) => o?.trim() || undefined);
    fallbacks.set(pattern, f);
  }
  return f;
}

// The family names written in a font file (name table, IDs 1 and 16, every
// language), as fontconfig knows the font: TrueType, OpenType, a
// collection's first font, WOFF. None for what cannot be read (WOFF2).
export function sfntFamilies(data: Buffer): string[] {
  try {
    const tag = data.toString('latin1', 0, 4);
    let tables: { tag: string; body: Buffer }[];
    if (tag === 'wOFF') {
      const n = data.readUInt16BE(12);
      tables = Array.from({ length: n }, (_, i) => {
        const at = 44 + 20 * i;
        const offset = data.readUInt32BE(at + 4);
        const comp = data.readUInt32BE(at + 8);
        const orig = data.readUInt32BE(at + 12);
        const raw = data.subarray(offset, offset + comp);
        return { tag: data.toString('latin1', at, at + 4), body: comp < orig ? inflateSync(raw) : raw };
      });
    } else {
      const base = tag === 'ttcf' ? data.readUInt32BE(12) : 0;
      const n = data.readUInt16BE(base + 4);
      tables = Array.from({ length: n }, (_, i) => {
        const at = base + 12 + 16 * i;
        const offset = data.readUInt32BE(at + 8);
        return { tag: data.toString('latin1', at, at + 4), body: data.subarray(offset, offset + data.readUInt32BE(at + 12)) };
      });
    }
    const name = tables.find((t) => t.tag === 'name')?.body;
    if (!name) return [];
    const count = name.readUInt16BE(2);
    const strings = name.readUInt16BE(4);
    const out = new Set<string>();
    for (let i = 0; i < count; i++) {
      const at = 6 + 12 * i;
      const platform = name.readUInt16BE(at);
      const id = name.readUInt16BE(at + 6);
      if (id !== 1 && id !== 16) continue;
      const s = name.subarray(strings + name.readUInt16BE(at + 10), strings + name.readUInt16BE(at + 10) + name.readUInt16BE(at + 8));
      const text = platform === 1 ? s.toString('latin1') : Buffer.from(s.subarray(0, s.length & ~1)).swap16().toString('utf16le');
      if (text.trim()) out.add(text.trim());
    }
    return [...out];
  } catch {
    return [];
  }
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

// Writes the setup in `dir` and returns the environment for Chromium. It
// keeps one rule, fontconfig's default hinting (its 10-hinting-slight.conf),
// under which Chromium places each character at the advance of the font, as
// wkhtmltopdf does; without it, fontconfig falls to full hinting, where
// Chromium rounds each advance to the pixel.
export function noAliasEnv(dir: string): NodeJS.ProcessEnv {
  if (process.platform !== 'linux') return {};
  const file = join(dir, 'fonts.conf');
  const dirs = fontDirs().filter((d) => existsSync(d)).map((d) => `  <dir>${d.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</dir>`);
  writeFileSync(file, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
${dirs.join('\n')}
  <match target="pattern">
    <edit name="hintstyle" mode="append"><const>hintslight</const></edit>
  </match>
  <cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>
`);
  return { FONTCONFIG_FILE: file };
}
