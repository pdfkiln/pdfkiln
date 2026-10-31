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
