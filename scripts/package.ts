// Assembles the archive of this platform from the single executable and
// the pinned Chromium:
//
//   Linux, macOS: pdfkiln-<version>-<platform>/
//     pdfkiln, wkhtmltopdf and wkhtmltoimage -> pdfkiln, chromium/, LICENSE,
//     licenses/
//   Windows: wkhtmltopdf/bin/wkhtmltopdf.exe, wkhtmltoimage.exe, pdfkiln.exe, chromium/,
//     with LICENSE and licenses/ in wkhtmltopdf/: unzipped in
//     C:\Program Files, it takes the old installer's path.
//
//   npm run bundle && node dist/scripts/sea.js && node dist/scripts/package.js [--launcher wkhtmltopdf.exe]
//
// Output: dist/package/<archive>.tar.gz or .zip, and its .sha256.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { installDir, platformKey, repoRoot } from '../src/chromium.js';
import { chromiumVersion, version } from '../src/version.js';
import { normalizeModes } from './modes.js';

const { values } = parseArgs({ options: { launcher: { type: 'string' } } });
const win = process.platform === 'win32';
const names: Record<string, string> = { linux64: 'linux-x64', 'linux-arm64': 'linux-arm64', 'mac-arm64': 'macos-arm64', 'mac-x64': 'macos-x64', win64: 'windows-x64' };
const key = platformKey();
const name = `pdfkiln-${version}-${names[key] ?? key}`;
const out = join(repoRoot, 'dist', 'package');
const root = join(out, name);
rmSync(out, { recursive: true, force: true });

const top = win ? join(root, 'wkhtmltopdf') : root;
const bin = win ? join(top, 'bin') : root;
mkdirSync(join(top, 'licenses'), { recursive: true });
mkdirSync(bin, { recursive: true });

// The program, and its other names.
const sea = join(repoRoot, 'dist', 'sea', win ? 'pdfkiln.exe' : 'pdfkiln');
cpSync(sea, join(bin, win ? 'pdfkiln.exe' : 'pdfkiln'));
if (win) {
  if (!values.launcher || !existsSync(values.launcher)) throw new Error('--launcher <wkhtmltopdf.exe> is needed on Windows (launcher/wkhtmltopdf.c)');
  // The launcher takes its mode from its own name.
  cpSync(values.launcher, join(bin, 'wkhtmltopdf.exe'));
  cpSync(values.launcher, join(bin, 'wkhtmltoimage.exe'));
} else {
  symlinkSync('pdfkiln', join(bin, 'wkhtmltopdf'));
  symlinkSync('pdfkiln', join(bin, 'wkhtmltoimage'));
}

// Chromium, next to the program.
const chromium = join(installDir(), `chrome-headless-shell-${key}`);
cpSync(chromium, join(bin, 'chromium'), { recursive: true, verbatimSymlinks: true });

// Licenses: ours, Node's, Chromium's, and those of the bundled packages.
cpSync(join(repoRoot, 'LICENSE'), join(top, 'LICENSE'));
const nodeLicense = [join(dirname(process.execPath), 'LICENSE'), join(dirname(process.execPath), '..', 'LICENSE')].find(existsSync);
if (nodeLicense) cpSync(nodeLicense, join(top, 'licenses', 'node.txt'));
const chromiumLicense = join(chromium, 'LICENSE.headless_shell');
if (existsSync(chromiumLicense)) cpSync(chromiumLicense, join(top, 'licenses', 'chromium.txt'));
// puppeteer-core is under Apache-2.0; its npm package has no license file.
cpSync(join(repoRoot, 'licenses', 'Apache-2.0.txt'), join(top, 'licenses', 'puppeteer-core-Apache-2.0.txt'));
const legal = join(repoRoot, 'dist', 'bundle', 'pdfkiln.cjs.LEGAL.txt');
if (existsSync(legal)) cpSync(legal, join(top, 'licenses', 'bundled-packages.txt'));
writeFileSync(join(top, 'README.txt'), `PDFKiln ${version}, Chromium ${chromiumVersion}, ${names[key] ?? key}

Called as wkhtmltopdf or wkhtmltoimage, PDFKiln accepts the command line of
wkhtmltopdf or wkhtmltoimage 0.12.6; called as pdfkiln, it offers its own interface (pdfkiln --help).
PDFKiln is not affiliated with the wkhtmltopdf project.
Documentation: https://pdfkiln.org
`);

// The archive and its checksum.
if (!win) normalizeModes(root);
const archive = join(out, `${name}${win ? '.zip' : '.tar.gz'}`);
// Windows' own tar (bsdtar) writes zip files; Git's GNU tar, first in the
// PATH of a bash step, takes "D:" for a remote host.
if (win) execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', archive, '-C', root, 'wkhtmltopdf']);
else execFileSync('tar', ['-czf', archive, '-C', out, name]);
const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${sha}  ${archive.split(/[\\/]/).pop()}\n`);
console.log(`${archive} ${(readFileSync(archive).length / 1e6).toFixed(1)} MB ${sha}`);
