// The channel manifests, written from a release's SHA-256 sums.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manifests, REPO, SITE } from '../scripts/manifests.js';

const files = ['linux-x64.tar.gz', 'linux-arm64.tar.gz', 'macos-x64.tar.gz', 'macos-arm64.tar.gz', 'windows-x64.zip', 'windows-x64-setup.exe']
  .map((f) => `pdfkiln-1.2.3-${f}`);
const sums = Object.fromEntries(files.map((f, i) => [f, String(i).repeat(64)]));

test('Scoop, winget, Homebrew and Composer point at the release, with its sums', () => {
  const m = manifests('1.2.3', sums);
  const scoop = JSON.parse(m['scoop/pdfkiln.json']!);
  assert.equal(scoop.architecture['64bit'].url, `${REPO}/releases/download/1.2.3/pdfkiln-1.2.3-windows-x64.zip`);
  assert.equal(scoop.architecture['64bit'].hash, '4'.repeat(64));
  assert.deepEqual(scoop.bin, ['bin\\wkhtmltopdf.exe', 'bin\\wkhtmltoimage.exe', 'bin\\pdfkiln.exe']);
  assert.equal(scoop.autoupdate.hash.url, '$baseurl/SHA256SUMS');
  const installer = m['winget/manifests/p/PDFKiln/PDFKiln/1.2.3/PDFKiln.PDFKiln.installer.yaml']!;
  assert.match(installer, /InstallerUrl: \S+\/1\.2\.3\/pdfkiln-1\.2\.3-windows-x64-setup\.exe\n  InstallerSha256: 5{64}\n/);
  assert.match(installer, /InstallerType: inno/);
  // The installer's AppId, which never changes: a new one would be another app.
  assert.match(installer, /\nProductCode: '\{6F3C2B4E-8D1A-4C5B-9E7F-2A1D3B4C5E6F\}_is1'\n/);
  const formula = m['homebrew/Formula/pdfkiln.rb']!;
  assert.match(formula, /url "\S+pdfkiln-1\.2\.3-macos-arm64\.tar\.gz"\n\s+sha256 "3{64}"/);
  assert.match(formula, /url "\S+pdfkiln-1\.2\.3-macos-x64\.tar\.gz"\n\s+sha256 "2{64}"/);
  // Chromium's dylibs out of Homebrew's relinking: packed, then unpacked.
  assert.match(formula, /def install\n.*"tar", "-cf", "chromium\.tar", "chromium"/s);
  assert.match(formula, /def post_install\n.*"tar", "-xf"/s);
  const pins = JSON.parse(m['composer/pins.json']!);
  assert.equal(pins.url, `${REPO}/releases/download/1.2.3`);
  assert.equal(Object.keys(pins.sha256).length, 5);
  const composer = JSON.parse(m['composer/composer.json']!);
  assert.deepEqual(composer.bin, ['bin/wkhtmltopdf', 'bin/wkhtmltoimage', 'bin/pdfkiln']);
  assert.deepEqual(composer.autoload, { files: ['src/launch.php'] });
});

test('Chocolatey runs the installer with its sum, PATH task on; uninstalls by name', () => {
  const m = manifests('1.2.3', sums);
  const nuspec = m['chocolatey/pdfkiln.nuspec']!;
  assert.match(nuspec, /<id>pdfkiln<\/id>\n\s+<version>1\.2\.3<\/version>/);
  assert.match(nuspec, /<title>PDFKiln<\/title>/);
  assert.match(nuspec, /<tags>wkhtmltopdf wkhtmltoimage /);
  assert.match(nuspec, /installs into `C:\\Program Files\\wkhtmltopdf`/);
  assert.match(nuspec, /<file src="tools\\\*\*" target="tools" \/>/);
  const install = m['chocolatey/tools/chocolateyinstall.ps1']!;
  assert.match(install, /url64bit\s+= '\S+\/1\.2\.3\/pdfkiln-1\.2\.3-windows-x64-setup\.exe'/);
  assert.match(install, /checksum64\s+= '5{64}'/);
  assert.match(install, /silentArgs\s+= '\/VERYSILENT \/SUPPRESSMSGBOXES \/NORESTART \/SP- \/TASKS=addtopath'/);
  assert.match(m['chocolatey/tools/chocolateyuninstall.ps1']!, /Get-UninstallRegistryKey -SoftwareName 'pdfkiln\*'/);
});

test('the AUR package: both Linux archives with their sums, laid out as the Debian package', () => {
  const m = manifests('1.2.3', sums);
  const pkgbuild = m['aur/PKGBUILD']!;
  assert.match(pkgbuild, /^pkgname=pdfkiln-bin\npkgver=1\.2\.3\npkgrel=1\n/m);
  assert.match(pkgbuild, /arch=\('x86_64' 'aarch64'\)/);
  assert.match(pkgbuild, /source_x86_64=\("pdfkiln-1\.2\.3-linux-x64\.tar\.gz::\S+\/1\.2\.3\/pdfkiln-1\.2\.3-linux-x64\.tar\.gz"\)\nsha256sums_x86_64=\('0{64}'\)/);
  assert.match(pkgbuild, /sha256sums_aarch64=\('1{64}'\)/);
  assert.match(pkgbuild, /provides=\('pdfkiln' 'wkhtmltopdf' 'wkhtmltoimage'\)/);
  assert.match(pkgbuild, /options=\('!strip' '!debug'\)/);
  assert.match(pkgbuild, /ln -s \.\.\/lib\/pdfkiln\/pdfkiln "\$pkgdir\/usr\/bin\/\$name"/);
  const srcinfo = m['aur/.SRCINFO']!;
  assert.match(srcinfo, /^pkgbase = pdfkiln-bin\n\tpkgdesc = .+\n\tpkgver = 1\.2\.3\n/);
  assert.match(srcinfo, /\tsha256sums_x86_64 = 0{64}\n/);
  assert.match(srcinfo, /\n\npkgname = pdfkiln-bin\n$/);
  // The same dependencies in both files.
  const deps = [...pkgbuild.match(/^depends=\((.*)\)$/m)![1]!.matchAll(/'([^']+)'/g)].map((d) => d[1]);
  assert.deepEqual([...srcinfo.matchAll(/\tdepends = (\S+)/g)].map((d) => d[1]), deps);
});

test('the AUR package has the Linux archives there are', () => {
  const x64Only = { ...sums };
  delete x64Only['pdfkiln-1.2.3-linux-arm64.tar.gz'];
  const m = manifests('1.2.3', x64Only);
  assert.match(m['aur/PKGBUILD']!, /arch=\('x86_64'\)/);
  assert.doesNotMatch(m['aur/PKGBUILD']!, /_aarch64=/);
  assert.doesNotMatch(m['aur/.SRCINFO']!, /aarch64/);
});

test('a file without its sum stops the generation', () => {
  const partial = { ...sums };
  delete partial['pdfkiln-1.2.3-windows-x64-setup.exe'];
  assert.throws(() => manifests('1.2.3', partial), /no SHA-256 for pdfkiln-1\.2\.3-windows-x64-setup\.exe/);
});

test('the formula has the macOS archives there are', () => {
  const armOnly = { ...sums };
  delete armOnly['pdfkiln-1.2.3-macos-x64.tar.gz'];
  const formula = manifests('1.2.3', armOnly)['homebrew/Formula/pdfkiln.rb']!;
  assert.match(formula, /on_arm do/);
  assert.doesNotMatch(formula, /on_intel/);
});

test('the site is the home page; GitHub keeps the downloads, the issues and the source', () => {
  const m = manifests('1.2.3', sums);
  assert.equal(JSON.parse(m['scoop/pdfkiln.json']!).homepage, SITE);
  assert.match(m['winget/manifests/p/PDFKiln/PDFKiln/1.2.3/PDFKiln.PDFKiln.locale.en-US.yaml']!, /PackageUrl: https:\/\/pdfkiln\.org\n/);
  assert.match(m['homebrew/Formula/pdfkiln.rb']!, /homepage "https:\/\/pdfkiln\.org"/);
  const composer = JSON.parse(m['composer/composer.json']!);
  assert.equal(composer.homepage, SITE);
  assert.deepEqual(composer.support, { issues: `${REPO}/issues`, source: REPO });
});
