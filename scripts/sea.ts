// Builds the single executable of this platform: the official Node.js of
// node.json, checked against its SHA-256, with dist/bundle/pdfkiln.cjs and
// its V8 code cache injected (Node's single executable applications,
// postject). The build runs on the same Node.js version, which makes the
// code cache.
//
//   npm run bundle && node dist/scripts/sea.js   ->  dist/sea/pdfkiln[.exe]
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inject } from 'postject';
import { repoRoot } from '../src/chromium.js';
import { fetchVerified, unzip } from './download.js';

interface NodePin { version: string; archives: Record<string, { url: string; sha256: string; binary: string }> }

const out = join(repoRoot, 'dist', 'sea');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const exe = join(out, process.platform === 'win32' ? 'pdfkiln.exe' : 'pdfkiln');
const blob = join(out, 'pdfkiln.blob');
const config = join(out, 'sea-config.json');

// Not whatever Node.js runs the build, which setup-node or a runner's
// cache provides unchecked: the archive pinned in node.json, as Chromium
// and wkhtmltopdf are.
const pin = JSON.parse(readFileSync(join(repoRoot, 'node.json'), 'utf8')) as NodePin;
if (process.version !== `v${pin.version}`) throw new Error(`build with Node.js ${pin.version} (node.json), not ${process.version}: the code cache is that version's`);
const node = pin.archives[`${process.platform}-${process.arch}`];
if (!node) throw new Error(`no Node.js pinned for ${process.platform}-${process.arch} in node.json`);
const archive = await fetchVerified(node.url, node.sha256);
const unpacked = join(out, 'node');
mkdirSync(unpacked);
if (archive.endsWith('.zip')) unzip(archive, unpacked);
else execFileSync('tar', ['-xzf', archive, '-C', unpacked]);

writeFileSync(config, JSON.stringify({
  main: join(repoRoot, 'dist', 'bundle', 'pdfkiln.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
}));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
copyFileSync(join(unpacked, node.binary), exe);
rmSync(unpacked, { recursive: true, force: true });
// The copy keeps the mode of the Node it copies: 0777 on GitHub's runners,
// which put a program anyone could replace in the archives and packages.
chmodSync(exe, 0o755);
// Node's symbol table and debug sections, which only a debugger reads:
// 18 MB of the 129 on Linux x64. Before the injection, which strip would
// damage. node.exe keeps its symbols apart, in a .pdb file.
if (process.platform === 'linux') execFileSync('strip', ['--strip-all', exe]);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe]);
await inject(exe, 'NODE_SEA_BLOB', await import('node:fs').then((fs) => fs.readFileSync(blob)), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
});
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);
rmSync(blob);
rmSync(config);
console.log(exe);
