// The manifests of the v1.1 channels, written from the SHA-256 sums of a release's files:
// Scoop, winget, a Homebrew formula and the Composer package. Nothing is
// published: each goes to its own repository or registry by hand, once the
// files are on GitHub Releases.
//
//   node dist/scripts/manifests.js --sums <folder of *.sha256> [--version 1.0.0]
//
// Output: dist/manifests/{scoop,winget,homebrew,composer}/
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { repoRoot } from '../src/chromium.js';

export const REPO = 'https://github.com/pdfkiln/pdfkiln';
export const SITE = 'https://pdfkiln.org';
const DESCRIPTION = 'Drop-in replacement for wkhtmltopdf, powered by Chromium';

// "<sha>  <file>" lines of the .sha256 files, by file name.
export function readSums(dir: string): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sha256'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
      if (m) sums[m[2]!] = m[1]!.toLowerCase();
    }
  }
  return sums;
}

export interface Manifests { [path: string]: string }

export function manifests(version: string, sums: Record<string, string>): Manifests {
  const url = `${REPO}/releases/download/${version}`;
  const file = (platform: string, ext: string) => `pdfkiln-${version}-${platform}${ext}`;
  const sum = (name: string) => {
    const s = sums[name];
    if (!s) throw new Error(`no SHA-256 for ${name}`);
    return s;
  };
  const out: Manifests = {};

  // Scoop: the zip, its programs on the PATH through Scoop's shims. A
  // release has no .sha256 per file: autoupdate finds the zip's line in
  // SHA256SUMS (Scoop's find_hash_in_textfile, by file name).
  const zip = file('windows-x64', '.zip');
  out['scoop/pdfkiln.json'] = `${JSON.stringify({
    version,
    description: DESCRIPTION,
    homepage: SITE,
    license: 'MIT',
    architecture: { '64bit': { url: `${url}/${zip}`, hash: sum(zip) } },
    extract_dir: 'wkhtmltopdf',
    bin: ['bin\\wkhtmltopdf.exe', 'bin\\wkhtmltoimage.exe', 'bin\\pdfkiln.exe'],
    checkver: { github: REPO },
    autoupdate: {
      architecture: { '64bit': { url: `${REPO}/releases/download/$version/pdfkiln-$version-windows-x64.zip` } },
      hash: { url: '$baseurl/SHA256SUMS' },
    },
  }, null, 2)}\n`;

  // winget: the installer, which keeps C:\Program Files\wkhtmltopdf.
  const setup = file('windows-x64', '-setup.exe');
  const id = 'PDFKiln.PDFKiln';
  const dir = `winget/manifests/p/PDFKiln/PDFKiln/${version}`;
  const head = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.{type}.1.12.0.schema.json\n\nPackageIdentifier: ${id}\nPackageVersion: ${version}\n`;
  out[`${dir}/${id}.yaml`] = `${head.replace('{type}', 'version')}DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.12.0\n`;
  out[`${dir}/${id}.installer.yaml`] = `${head.replace('{type}', 'installer')}InstallerType: inno
Scope: machine
UpgradeBehavior: install
Commands:
- wkhtmltopdf
- wkhtmltoimage
- pdfkiln
Installers:
- Architecture: x64
  InstallerUrl: ${url}/${setup}
  InstallerSha256: ${sum(setup).toUpperCase()}
ManifestType: installer
ManifestVersion: 1.12.0
`;
  out[`${dir}/${id}.locale.en-US.yaml`] = `${head.replace('{type}', 'defaultLocale')}PackageLocale: en-US
Publisher: PDFKiln
PublisherUrl: ${SITE}
PackageName: PDFKiln
PackageUrl: ${SITE}
License: MIT
LicenseUrl: ${REPO}/blob/main/LICENSE
ShortDescription: ${DESCRIPTION}
Description: Called as wkhtmltopdf or wkhtmltoimage, PDFKiln accepts the command lines of wkhtmltopdf and wkhtmltoimage 0.12.6 and renders with Chromium. Not affiliated with the wkhtmltopdf project.
Moniker: pdfkiln
Tags:
- wkhtmltopdf
- pdf
- html-to-pdf
- chromium
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`;

  // Homebrew: a formula for a tap of ours, from the macOS archives built
  // (CI builds ARM64 only). A formula rather than a cask: a cask's download
  // is quarantined, and Gatekeeper stops a program that is not notarized.
  const mac = [['arm', file('macos-arm64', '.tar.gz')], ['intel', file('macos-x64', '.tar.gz')]].filter(([, f]) => sums[f!]);
  if (!mac.length) throw new Error('no SHA-256 for a macOS archive');
  out['homebrew/Formula/pdfkiln.rb'] = `class Pdfkiln < Formula
  desc "${DESCRIPTION}"
  homepage "${SITE}"
  version "${version}"
  license "MIT"

  on_macos do
${mac.map(([cpu, f]) => `    on_${cpu} do
      url "${url}/${f}"
      sha256 "${sum(f!)}"
    end
`).join('')}  end

  # Homebrew rewrites the ID of every dylib in a keg after install: those
  # of Chromium have no room for it, and would lose Google's signature.
  # Chromium goes in as a tar, unpacked by post_install, which runs after.
  def install
    system "tar", "-cf", "chromium.tar", "chromium"
    rm_r "chromium"
    libexec.install Dir["*"]
    %w[pdfkiln wkhtmltopdf wkhtmltoimage].each { |name| bin.install_symlink libexec/name }
  end

  def post_install
    tar = libexec/"chromium.tar"
    return unless tar.exist?

    rm_r libexec/"chromium" if (libexec/"chromium").exist?
    system "tar", "-xf", tar, "-C", libexec
    tar.delete
  end

  test do
    assert_match "wkhtmltopdf 0.12.6", shell_output("#{bin}/wkhtmltopdf --version")
    assert_match "wkhtmltoimage 0.12.6", shell_output("#{bin}/wkhtmltoimage --version")
  end
end
`;

  // Composer: the launchers of packaging/composer, and the sums they
  // check the downloaded archive against; Pdfkiln\binary() autoloaded.
  const archives = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'].map((p) => file(p, '.tar.gz')).concat(zip);
  out['composer/pins.json'] = `${JSON.stringify({
    version,
    url,
    sha256: Object.fromEntries(archives.filter((a) => sums[a]).map((a) => [a, sums[a]!])),
  }, null, 2)}\n`;
  out['composer/composer.json'] = `${JSON.stringify({
    name: 'pdfkiln/pdfkiln',
    description: `${DESCRIPTION}: vendor/bin/wkhtmltopdf and vendor/bin/wkhtmltoimage, downloaded on first use`,
    type: 'library',
    keywords: ['wkhtmltopdf', 'wkhtmltoimage', 'pdf', 'chromium'],
    homepage: SITE,
    license: 'MIT',
    require: { php: '>=7.4' },
    autoload: { files: ['src/launch.php'] },
    bin: ['bin/wkhtmltopdf', 'bin/wkhtmltoimage', 'bin/pdfkiln'],
    support: { issues: `${REPO}/issues`, source: REPO },
  }, null, 4)}\n`;
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { sums: { type: 'string' }, version: { type: 'string' } } });
  if (!values.sums) throw new Error('--sums <folder of the release\'s .sha256 files> is required');
  const version = values.version ?? (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
  const out = join(repoRoot, 'dist', 'manifests');
  rmSync(out, { recursive: true, force: true });
  cpSync(join(repoRoot, 'packaging', 'composer'), join(out, 'composer'), { recursive: true });
  cpSync(join(repoRoot, 'LICENSE'), join(out, 'composer', 'LICENSE'));
  for (const [path, text] of Object.entries(manifests(version, readSums(values.sums)))) {
    mkdirSync(join(out, path, '..'), { recursive: true });
    writeFileSync(join(out, path), text);
  }
  console.log(`${out}: scoop, winget, homebrew, composer for ${version}`);
}
