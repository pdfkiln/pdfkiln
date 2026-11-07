// Bundles the command into one ESM file per entry point: Node loads one
// file instead of the hundreds of modules of puppeteer-core and pdf-lib,
// which halves the start-up time, and the single executable embeds it.
//
//   node dist/scripts/bundle.js   ->  dist/bundle/pdfkiln.cjs, wkhtmltopdf.cjs, wkhtmltoimage.cjs
//
// CommonJS, the format of Node's single executable applications.
//
// The license file of each package bundled goes in dist/bundle/licenses/,
// which the packages ship (scripts/package.ts, scripts/npm.ts): most of
// them carry no license comment for legalComments to keep.
import { build } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/chromium.js';
import { readMarkdownAssets } from '../src/markdown/assets.js';

const result = await build({
  // The metafile's paths, relative to the repository, name the packages.
  absWorkingDir: repoRoot,
  metafile: true,
  // KaTeX's style sheet and fonts and highlight.js's theme, which the
  // bundle cannot read from node_modules (src/markdown/assets.ts).
  define: { PDFKILN_MARKDOWN_ASSETS: JSON.stringify(readMarkdownAssets(join(repoRoot, 'package.json'))) },
  entryPoints: {
    pdfkiln: join(repoRoot, 'src', 'bin', 'pdfkiln.ts'),
    wkhtmltopdf: join(repoRoot, 'src', 'bin', 'wkhtmltopdf.ts'),
    wkhtmltoimage: join(repoRoot, 'src', 'bin', 'wkhtmltoimage.ts'),
  },
  outdir: join(repoRoot, 'dist', 'bundle'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  minifySyntax: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  legalComments: 'linked',
  // Optional native modules of ws, and WebDriver BiDi, never used with a pipe.
  external: ['bufferutil', 'utf-8-validate', 'chromium-bidi', 'chromium-bidi/*'],
  logLevel: 'warning',
  // src/chromium.ts falls back on __dirname in CommonJS.
  logOverride: { 'empty-import-meta': 'silent' },
});

// Each package's folder: the last node_modules/<name>/ of a path, since a
// copy nested in another package's node_modules is a package of its own.
const packages = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+\//.exec(input.replace(/\\/g, '/'));
  if (m) packages.add(m[0]);
}
// Without a license file, under Apache-2.0: the packages ship
// licenses/Apache-2.0.txt. Any other package without one stops the bundle.
const apache = new Set(['puppeteer-core', '@puppeteer/browsers']);
const licenses = join(repoRoot, 'dist', 'bundle', 'licenses');
rmSync(licenses, { recursive: true, force: true });
mkdirSync(licenses, { recursive: true });
const depth = (dir: string): number => dir.split('node_modules/').length;
for (const dir of [...packages].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1))) {
  const name = /node_modules\/((?:@[^/]+\/)?[^/]+)\/$/.exec(dir)![1]!;
  const file = readdirSync(join(repoRoot, dir)).find((f) => /^(licen[cs]e|copying)/i.test(f));
  if (!file) {
    if (apache.has(name)) continue;
    throw new Error(`${dir} has no license file: ship its license (scripts/bundle.ts)`);
  }
  // Two copies of one package: one file when their licenses are the same,
  // else the nested one's is named after its version.
  const text = readFileSync(join(repoRoot, dir, file));
  let to = join(licenses, `${name.replace('/', '__')}.txt`);
  if (existsSync(to) && !readFileSync(to).equals(text)) {
    const { version } = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as { version: string };
    to = join(licenses, `${name.replace('/', '__')}@${version}.txt`);
  }
  writeFileSync(to, text);
}
