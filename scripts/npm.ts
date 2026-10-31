// The npm package: the two bundled commands, chromium.json, and no
// dependency. Chromium is downloaded on first use into the user's cache
// (src/chromium.ts). The bundles keep their place, dist/bundle/, two
// levels below the package, where they find chromium.json.
//
//   npm run bundle && node dist/scripts/npm.js
//
// Output: dist/package/pdfkiln-pdfkiln-<version>.tgz (npm pack), the package
// @pdfkiln/pdfkiln: npm refuses the unscoped name pdfkiln, too close to
// pdfkit's.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPin, repoRoot } from '../src/chromium.js';
import { chromiumVersion, version } from '../src/version.js';

const dev = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const root = join(repoRoot, 'dist', 'npm', 'pdfkiln');
const out = join(repoRoot, 'dist', 'package');
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'dist', 'bundle'), { recursive: true });
mkdirSync(join(root, 'licenses'), { recursive: true });
mkdirSync(out, { recursive: true });

for (const f of ['pdfkiln.cjs', 'wkhtmltopdf.cjs', 'wkhtmltoimage.cjs']) cpSync(join(repoRoot, 'dist', 'bundle', f), join(root, 'dist', 'bundle', f));
cpSync(join(repoRoot, 'chromium.json'), join(root, 'chromium.json'));
cpSync(join(repoRoot, 'LICENSE'), join(root, 'LICENSE'));
cpSync(join(repoRoot, 'licenses', 'Apache-2.0.txt'), join(root, 'licenses', 'puppeteer-core-Apache-2.0.txt'));
const legal = join(repoRoot, 'dist', 'bundle', 'pdfkiln.cjs.LEGAL.txt');
if (existsSync(legal)) cpSync(legal, join(root, 'licenses', 'bundled-packages.txt'));

const platforms = Object.keys(readPin().archives).join(', ');
writeFileSync(join(root, 'README.md'), `# PDFKiln

Drop-in replacement for wkhtmltopdf, powered by Chromium.

Documentation and migration guides: https://pdfkiln.org

\`npx @pdfkiln/pdfkiln wkhtmltopdf page.html page.pdf\`, or \`npm install -g @pdfkiln/pdfkiln\` for the three commands:

- \`wkhtmltopdf\` and \`wkhtmltoimage\` accept the command lines of wkhtmltopdf and wkhtmltoimage 0.12.6, with the same options, defaults, messages and exit codes;
- \`pdfkiln\` offers its own interface, with modern print defaults (\`pdfkiln --help\`).

The first conversion downloads chrome-headless-shell ${chromiumVersion} (Chrome for Testing, ${platforms}), checks its SHA-256, and keeps it in the user's cache: \`~/.cache/pdfkiln\` (or \`$XDG_CACHE_HOME\`), \`~/Library/Caches/pdfkiln\`, \`%LOCALAPPDATA%\\pdfkiln\`. \`PDFKILN_CACHE_DIR\` changes that folder; \`PDFKILN_CHROMIUM\` points to a chrome-headless-shell of your own.

Chromium's sandbox stays on: run as an unprivileged user. On Ubuntu 23.10 and later, AppArmor restricts the user namespaces it needs; an AppArmor profile for the downloaded binary allows them.

PDFKiln is not affiliated with the wkhtmltopdf project. MIT license; Chromium, Node.js and the bundled packages keep theirs (\`licenses/\`).
`);

writeFileSync(join(root, 'package.json'), `${JSON.stringify({
  name: '@pdfkiln/pdfkiln',
  version,
  description: dev.description,
  license: dev.license,
  homepage: 'https://pdfkiln.org',
  bugs: { url: 'https://github.com/pdfkiln/pdfkiln/issues' },
  repository: { type: 'git', url: 'git+https://github.com/pdfkiln/pdfkiln.git' },
  bin: { pdfkiln: 'dist/bundle/pdfkiln.cjs', wkhtmltopdf: 'dist/bundle/wkhtmltopdf.cjs', wkhtmltoimage: 'dist/bundle/wkhtmltoimage.cjs' },
  files: ['dist/bundle/*.cjs', 'chromium.json', 'licenses/'],
  engines: dev.engines,
  os: ['linux', 'darwin', 'win32'],
}, null, 2)}\n`);

const packed = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--pack-destination', out], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
const [info] = JSON.parse(packed) as { filename: string; size: number; unpackedSize: number; entryCount: number }[];
console.log(`${join(out, info!.filename)} ${(info!.size / 1e6).toFixed(1)} MB, ${(info!.unpackedSize / 1e6).toFixed(1)} MB unpacked, ${info!.entryCount} files`);
