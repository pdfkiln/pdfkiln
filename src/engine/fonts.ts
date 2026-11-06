// wkhtmltopdf's fonts on Linux: its Qt takes a font only when the family is
// installed, and its default font for any other family, generic ones
// included. Chromium is given a fontconfig setup without the substitution
// rules, and the default font for every generic family.
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DefaultFamily {
  // Settles once fc-match runs (true) or could not start (false).
  started: Promise<boolean>;
  // What fontconfig gives Qt for its default family, "Helvetica".
  family: Promise<string | undefined>;
}

let qtDefault: DefaultFamily | undefined;

// fc-match, in the background: it takes 0.3 s on a server with ten
// thousand fonts, which it spends while Chromium starts.
export function qtDefaultFamily(): DefaultFamily {
  if (process.platform !== 'linux') return { started: Promise.resolve(false), family: Promise.resolve(undefined) };
  if (!qtDefault) {
    let child!: ChildProcess;
    const family = new Promise<string | undefined>((resolve) => {
      child = execFile('fc-match', ['-f', '%{family[0]}', 'Helvetica'], { encoding: 'utf8', timeout: 5000 }, (e, out) => resolve(e ? undefined : out.trim() || undefined));
    });
    const started = new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    qtDefault = { started, family };
  }
  return qtDefault;
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
