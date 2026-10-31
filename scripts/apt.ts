// The APT repository: the Debian packages of both architectures in the
// layout apt expects, and their index signed with the repository's key.
//
//   node dist/scripts/apt.js --repo <dir> --key <fingerprint> [--keep 3] [<file.deb>...]
//
// <dir> holds the repository as published (a copy of the bucket, or empty):
//
//   pool/main/p/pdfkiln/*.deb
//   dists/stable/Release, InRelease, Release.gpg
//   dists/stable/main/binary-{amd64,arm64}/Packages, Packages.gz
//   pdfkiln-archive-keyring.asc   the public key, for a manual setup
//
// The added packages go to the pool, the oldest beyond --keep per
// architecture leave it, and the index is written again and signed by gpg
// (its GNUPGHOME; APT_GPG_PASSPHRASE when the key has one). Linux only:
// apt-ftparchive (apt-utils), dpkg-deb and gpg.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const { values, positionals: added } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    key: { type: 'string' },
    keep: { type: 'string', default: '3' },
  },
});
if (!values.repo || !values.key) throw new Error('usage: apt.js --repo <dir> --key <fingerprint> [--keep 3] [<file.deb>...]');
const ARCHES = ['amd64', 'arm64'];
const repo = resolve(values.repo);
const run = (cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });

const pool = join(repo, 'pool', 'main', 'p', 'pdfkiln');
mkdirSync(pool, { recursive: true });
for (const deb of added) copyFileSync(resolve(deb), join(pool, basename(deb)));

// The newest --keep versions of each architecture stay, in dpkg's order.
const field = (deb: string, name: string) => run('dpkg-deb', ['--field', deb, name]).trim();
const newer = (a: string, b: string) => {
  try {
    run('dpkg', ['--compare-versions', a, 'gt', b]);
    return true;
  } catch {
    return false;
  }
};
const debs = readdirSync(pool).filter((f) => f.endsWith('.deb')).map((f) => {
  const file = join(pool, f);
  return { file, version: field(file, 'Version'), arch: field(file, 'Architecture') };
});
for (const arch of ARCHES) {
  const kept = debs.filter((d) => d.arch === arch).sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
  for (const d of kept.slice(Number(values.keep))) {
    rmSync(d.file);
    console.log(`removed ${basename(d.file)}`);
  }
  for (const d of kept.slice(0, Number(values.keep))) console.log(`${arch}: ${d.version}`);
}

// The index, written from scratch: paths relative to the repository's
// root, as apt asks for them.
const dist = join(repo, 'dists', 'stable');
rmSync(dist, { recursive: true, force: true });
for (const arch of ARCHES) {
  const dir = join(dist, 'main', `binary-${arch}`);
  mkdirSync(dir, { recursive: true });
  const packages = run('apt-ftparchive', ['--arch', arch, 'packages', 'pool'], { cwd: repo });
  writeFileSync(join(dir, 'Packages'), packages);
  writeFileSync(join(dir, 'Packages.gz'), gzipSync(packages, { level: 9 }));
}
const release = run('apt-ftparchive', [
  '-o', 'APT::FTPArchive::Release::Origin=pdfkiln',
  '-o', 'APT::FTPArchive::Release::Label=pdfkiln',
  '-o', 'APT::FTPArchive::Release::Suite=stable',
  '-o', 'APT::FTPArchive::Release::Codename=stable',
  '-o', `APT::FTPArchive::Release::Architectures=${ARCHES.join(' ')}`,
  '-o', 'APT::FTPArchive::Release::Components=main',
  '-o', 'APT::FTPArchive::Release::Description=PDFKiln, a drop-in replacement for wkhtmltopdf',
  'release', '.',
], { cwd: dist });
writeFileSync(join(dist, 'Release'), release);

// InRelease for current apt, Release.gpg for older clients.
const passphrase = process.env.APT_GPG_PASSPHRASE;
const gpg = (args: string[]) => run('gpg', [
  '--batch', '--yes', '--local-user', values.key!, '--digest-algo', 'SHA512',
  ...(passphrase !== undefined ? ['--pinentry-mode', 'loopback', '--passphrase-fd', '0'] : []),
  ...args,
], { input: passphrase ?? '' });
gpg(['--clearsign', '--output', join(dist, 'InRelease'), join(dist, 'Release')]);
gpg(['--detach-sign', '--armor', '--output', join(dist, 'Release.gpg'), join(dist, 'Release')]);
writeFileSync(join(repo, 'pdfkiln-archive-keyring.asc'), run('gpg', ['--armor', '--export', values.key]));
console.log(`signed ${join(dist, 'InRelease')}`);
