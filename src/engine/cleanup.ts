// What a conversion leaves behind on Windows, where the command returns as
// soon as the PDF is written (src/engine/browser.ts): this same program,
// started detached with PDFKILN_CLEANUP naming the conversion's folder,
// removes that folder once Chromium, ended, has let go of its files, and
// exits. It loads nothing else. Only a folder of a conversion is removed:
// pdfkiln-* in the temporary folder.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

// Set by the program's entries, which run cleanup() when started as the
// helper: only then is the helper this program. Run from anything else (a
// bench, a script that imports the engine), the helper would run that other
// program again, and each run start the next: a conversion then removes its
// folder itself.
let entry = false;
export function markHelperEntry(): void {
  entry = true;
}
export function isHelperEntry(): boolean {
  return entry && !process.env.PDFKILN_CLEANUP;
}

// mkdtemp(join(tmpdir(), 'pdfkiln-')): six characters after the prefix.
export function isConversionFolder(dir: string, tmp = tmpdir(), platform = process.platform): boolean {
  const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const d = resolve(dir);
  return same(dirname(d), resolve(tmp)) && /^pdfkiln-[A-Za-z0-9]{6}$/.test(basename(d));
}

// Retries for 30 s: Chromium's processes take a moment to leave, and keep
// their files locked until then.
export function cleanup(dir: string): void {
  if (!isConversionFolder(dir)) process.exit(1);
  const end = Date.now() + 30000;
  const attempt = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      process.exit(0);
    } catch {
      if (Date.now() > end) process.exit(1);
      setTimeout(attempt, 100);
    }
  };
  attempt();
}
