// One program, two names: the name it is called by, or "pdfkiln
// wkhtmltopdf", picks the mode; never the options.
import { writeSync } from 'node:fs';
import { basename } from 'node:path';

export function modeOf(name: string): 'wkhtmltopdf' | 'wkhtmltoimage' | 'native' {
  const n = basename(name).replace(/\.exe$/i, '').toLowerCase();
  return n === 'wkhtmltopdf' || n === 'wkhtmltoimage' ? n : 'native';
}

export async function main(name: string, args: string[]): Promise<number> {
  const mode = modeOf(name);
  // Each mode loads its own modules only.
  if (mode === 'wkhtmltopdf') return (await import('./wk/main.js')).wkMain(['wkhtmltopdf', ...args]);
  if (mode === 'wkhtmltoimage') return (await import('./wk/main.js')).wkImageMain(['wkhtmltoimage', ...args]);
  if (args[0] === 'wkhtmltopdf') return (await import('./wk/main.js')).wkMain(['wkhtmltopdf', ...args.slice(1)]);
  if (args[0] === 'wkhtmltoimage') return (await import('./wk/main.js')).wkImageMain(['wkhtmltoimage', ...args.slice(1)]);
  // Up to 1.1.x, Chromium kept open between conversions.
  if (args[0] === 'serve') {
    writeSync(2, 'pdfkiln serve was removed in 1.2.0: each conversion starts its own Chromium\n');
    return 1;
  }
  return (await import('./native/main.js')).nativeMain(args);
}
