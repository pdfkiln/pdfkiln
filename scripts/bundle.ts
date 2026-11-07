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
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/chromium.js';
import { readMarkdownAssets } from '../src/markdown/assets.js';

const result = await build({
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

const licenses = join(repoRoot, 'dist', 'bundle', 'licenses');
rmSync(licenses, { recursive: true, force: true });
mkdirSync(licenses, { recursive: true });
const packages = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));
  if (m) packages.add(input.replace(/\\/g, '/').slice(0, m.index + m[0].length));
}
for (const dir of [...packages].sort()) {
  const name = /node_modules\/((?:@[^/]+\/)?[^/]+)\/$/.exec(dir)![1]!;
  const file = readdirSync(join(repoRoot, dir)).find((f) => /^(licen[cs]e|copying)/i.test(f));
  // puppeteer-core's has none: licenses/Apache-2.0.txt.
  if (file) copyFileSync(join(repoRoot, dir, file), join(licenses, `${name.replace('/', '__')}.txt`));
}
