// Builds the single executable of this platform: the Node.js running this
// script, with dist/bundle/pdfkiln.cjs and its V8 code cache injected
// (Node's single executable applications, postject).
//
//   npm run bundle && node dist/scripts/sea.js   ->  dist/sea/pdfkiln[.exe]
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'postject';
import { repoRoot } from '../src/chromium.js';

const out = join(repoRoot, 'dist', 'sea');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const exe = join(out, process.platform === 'win32' ? 'pdfkiln.exe' : 'pdfkiln');
const blob = join(out, 'pdfkiln.blob');
const config = join(out, 'sea-config.json');
writeFileSync(config, JSON.stringify({
  main: join(repoRoot, 'dist', 'bundle', 'pdfkiln.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
}));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
copyFileSync(process.execPath, exe);
// The copy keeps the mode of the Node it copies: 0777 on GitHub's runners,
// which put a program anyone could replace in the archives and packages.
chmodSync(exe, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe]);
await inject(exe, 'NODE_SEA_BLOB', await import('node:fs').then((fs) => fs.readFileSync(blob)), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);
rmSync(blob);
rmSync(config);
console.log(exe);
