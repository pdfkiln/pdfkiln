// The Debian package, made from the Linux archive's directory that
// scripts/package.ts leaves in dist/package:
//
//   /usr/lib/pdfkiln/   pdfkiln, chromium/
//   /usr/bin/pdfkiln, /usr/bin/wkhtmltopdf, /usr/bin/wkhtmltoimage -> ../lib/pdfkiln/pdfkiln
//   /usr/share/doc/pdfkiln/   copyright (our license and the others), README.txt
//   /lib/systemd/system/pdfkiln@.service   pdfkiln serve for one user, not enabled
//
// It provides wkhtmltopdf and replaces the official wkhtmltox package. On
// systems whose AppArmor restricts user namespaces (Ubuntu 23.10 and
// later), postinst loads a profile that allows them to Chromium, as Ubuntu
// does for Chrome: the sandbox stays on.
//
// The version is pdfkiln's and the Debian revision: Chromium only changes
// with a new pdfkiln version. With the APT repository's address and key
// (options, or packaging/apt/repository.json), the package also installs its
// source and key, as Chrome's does: installed by hand, it still gets the
// updates.
//
//   node dist/scripts/package.js && node dist/scripts/deb.js
//     [--apt-url <url> --apt-key <key.asc>] [--revision <n>] [--out <dir>]
//
// Output: dist/package/pdfkiln_<version>-<revision>_<arch>.deb
// and its .sha256.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { platformKey, repoRoot } from '../src/chromium.js';
import { chromiumVersion, version } from '../src/version.js';
import { normalizeModes } from './modes.js';

const { values } = parseArgs({
  options: {
    'apt-url': { type: 'string' },
    'apt-key': { type: 'string' },
    revision: { type: 'string', default: '1' },
    out: { type: 'string' },
  },
});
// The repository of releases, once it exists: { "url": ..., "key": "<file next to it>" }.
const repository = join(repoRoot, 'packaging', 'apt', 'repository.json');
const apt = values['apt-url'] && values['apt-key']
  ? { url: values['apt-url'], key: resolve(values['apt-key']) }
  : existsSync(repository)
    ? (({ url, key }: { url: string; key: string }) => ({ url, key: join(dirname(repository), key) }))(JSON.parse(readFileSync(repository, 'utf8')))
    : undefined;

const arches: Record<string, [string, string]> = { linux64: ['amd64', 'linux-x64'], 'linux-arm64': ['arm64', 'linux-arm64'] };
const target = arches[platformKey()];
if (!target) throw new Error('The Debian package is built on Linux');
const [arch, platform] = target;
const archives = join(repoRoot, 'dist', 'package');
const out = values.out ? resolve(values.out) : archives;
mkdirSync(out, { recursive: true });
const from = join(archives, `pdfkiln-${version}-${platform}`);
const debVersion = `${version}-${values.revision}`;
const name = `pdfkiln_${debVersion}_${arch}`;
const root = join(out, name);
rmSync(root, { recursive: true, force: true });

const lib = join(root, 'usr', 'lib', 'pdfkiln');
const doc = join(root, 'usr', 'share', 'doc', 'pdfkiln');
mkdirSync(lib, { recursive: true });
mkdirSync(join(root, 'usr', 'bin'), { recursive: true });
mkdirSync(doc, { recursive: true });
cpSync(join(from, 'pdfkiln'), join(lib, 'pdfkiln'));
cpSync(join(from, 'chromium'), join(lib, 'chromium'), { recursive: true, verbatimSymlinks: true });
symlinkSync('../lib/pdfkiln/pdfkiln', join(root, 'usr', 'bin', 'pdfkiln'));
symlinkSync('../lib/pdfkiln/pdfkiln', join(root, 'usr', 'bin', 'wkhtmltopdf'));
symlinkSync('../lib/pdfkiln/pdfkiln', join(root, 'usr', 'bin', 'wkhtmltoimage'));

// Chromium kept open for one user's conversions, not enabled:
// systemctl enable --now pdfkiln@odoo
mkdirSync(join(root, 'lib', 'systemd', 'system'), { recursive: true });
writeFileSync(join(root, 'lib', 'systemd', 'system', 'pdfkiln@.service'), `[Unit]
Description=PDFKiln: Chromium kept open for the conversions of %i
After=network.target

[Service]
User=%i
ExecStart=/usr/bin/pdfkiln serve
Restart=on-failure

[Install]
WantedBy=multi-user.target
`);

// copyright: ours first, then each license of the archive.
const licenses = readdirSync(join(from, 'licenses')).sort();
writeFileSync(join(doc, 'copyright'), [
  `PDFKiln ${version}, with Chromium ${chromiumVersion} (chrome-headless-shell) and Node.js.`,
  'PDFKiln is not affiliated with the wkhtmltopdf project.',
  '',
  '== PDFKiln ==',
  '',
  readFileSync(join(from, 'LICENSE'), 'utf8'),
  ...licenses.flatMap((f) => [`== ${f} ==`, '', readFileSync(join(from, 'licenses', f), 'utf8')]),
].join('\n'));
cpSync(join(from, 'README.txt'), join(doc, 'README.txt'));

// The repository's source, a configuration file (kept if the user edits
// it, removed on purge), and its key, which only that source trusts.
const conffiles: string[] = [];
if (apt) {
  mkdirSync(join(root, 'usr', 'share', 'keyrings'), { recursive: true });
  cpSync(apt.key, join(root, 'usr', 'share', 'keyrings', 'pdfkiln-archive-keyring.asc'));
  mkdirSync(join(root, 'etc', 'apt', 'sources.list.d'), { recursive: true });
  writeFileSync(join(root, 'etc', 'apt', 'sources.list.d', 'pdfkiln.sources'), aptSource(apt.url));
  conffiles.push('/etc/apt/sources.list.d/pdfkiln.sources');
}

// Chromium's libraries (readelf -d of chrome-headless-shell and its .so
// files), with the names Debian 12 and the t64 names of Debian 13 and
// Ubuntu 24.04; Liberation for Arial's metrics.
const depends = [
  'libc6 (>= 2.28)', 'libasound2t64 | libasound2', 'libatk-bridge2.0-0t64 | libatk-bridge2.0-0', 'libatk1.0-0t64 | libatk1.0-0',
  'libatspi2.0-0t64 | libatspi2.0-0', 'libdbus-1-3', 'libexpat1', 'libgbm1', 'libgcc-s1', 'libglib2.0-0t64 | libglib2.0-0',
  'libnspr4', 'libnss3', 'libudev1', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6', 'libxfixes3',
  'libxkbcommon0', 'libxrandr2', 'fontconfig', 'fonts-liberation',
];
const size = (p: string): number => {
  const s = lstatSync(p, { throwIfNoEntry: false });
  if (!s || s.isSymbolicLink()) return 0;
  return s.isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : s.size;
};
const debian = join(root, 'DEBIAN');
mkdirSync(debian);
writeFileSync(join(debian, 'control'), `Package: pdfkiln
Version: ${debVersion}
Architecture: ${arch}
Maintainer: Jamal Tantaoui <contact@pdfkiln.org>
Homepage: https://pdfkiln.org
Installed-Size: ${Math.ceil(size(join(root, 'usr')) / 1024)}
Depends: ${depends.join(', ')}
Provides: wkhtmltopdf
Conflicts: wkhtmltopdf, wkhtmltox
Replaces: wkhtmltopdf, wkhtmltox
Section: text
Priority: optional
Description: drop-in replacement for wkhtmltopdf, powered by Chromium
 Called as wkhtmltopdf or wkhtmltoimage, PDFKiln accepts the command line
 of wkhtmltopdf or wkhtmltoimage 0.12.6, with the same options, defaults, messages and exit codes; called
 as pdfkiln, it offers its own interface, with modern print defaults.
 It ships its own Chromium (chrome-headless-shell ${chromiumVersion}).
`);
const profile = `abi <abi/4.0>,
include <tunables/global>

profile pdfkiln /usr/lib/pdfkiln/chromium/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/pdfkiln>
}
`;
// The profile is written only where AppArmor knows the 4.0 rules: Debian
// 12's AppArmor would refuse it, and does not restrict user namespaces.
writeFileSync(join(debian, 'postinst'), `#!/bin/sh
set -e
if [ "$1" = configure ] && [ -e /etc/apparmor.d/abi/4.0 ]; then
  cat > /etc/apparmor.d/pdfkiln <<'EOF'
${profile}EOF
  if command -v apparmor_parser > /dev/null && [ -d /sys/kernel/security/apparmor ]; then
    apparmor_parser -r -W /etc/apparmor.d/pdfkiln || true
  fi
fi
`);
writeFileSync(join(debian, 'postrm'), `#!/bin/sh
set -e
if [ "$1" = remove ] || [ "$1" = purge ]; then
  if [ -e /etc/apparmor.d/pdfkiln ]; then
    if command -v apparmor_parser > /dev/null && [ -d /sys/kernel/security/apparmor ]; then
      apparmor_parser -R /etc/apparmor.d/pdfkiln > /dev/null 2>&1 || true
    fi
    rm -f /etc/apparmor.d/pdfkiln
  fi
fi
`);
for (const f of ['postinst', 'postrm']) chmodSync(join(debian, f), 0o755);
if (conffiles.length) writeFileSync(join(debian, 'conffiles'), `${conffiles.join('\n')}\n`);
normalizeModes(root);

const deb = join(out, `${name}.deb`);
execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', root, deb], { stdio: 'inherit' });
rmSync(root, { recursive: true });
const sha = createHash('sha256').update(readFileSync(deb)).digest('hex');
writeFileSync(`${deb}.sha256`, `${sha}  ${name}.deb\n`);
console.log(`${deb} ${(readFileSync(deb).length / 1e6).toFixed(1)} MB ${sha}`);

// The same source as the README gives for a manual setup: dpkg finds the
// file it would install already there and keeps it without asking.
function aptSource(url: string): string {
  return `Types: deb
URIs: ${url}
Suites: stable
Components: main
Signed-By: /usr/share/keyrings/pdfkiln-archive-keyring.asc
`;
}
