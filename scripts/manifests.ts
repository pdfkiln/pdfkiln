// The manifests of the v1.1 channels, written from the SHA-256 sums of a release's files:
// Scoop, winget, a Homebrew formula, Chocolatey, the AUR and the Composer
// package. Nothing is published: each goes to its own repository or
// registry by hand, once the files are on GitHub Releases.
//
//   node dist/scripts/manifests.js --sums <folder of *.sha256> [--version 1.0.0]
//
// Output: dist/manifests/{scoop,winget,homebrew,chocolatey,aur,composer}/
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
  // {AppId}_is1, the key of the installed app in Windows: by it winget knows
  // an installed PDFKiln whatever its name and publisher there (1.1.0 gave
  // pdfkiln and Jamalofski).
  const appId = /^AppId=\{(\{[0-9A-F-]+\})\s*$/m.exec(readFileSync(join(repoRoot, 'packaging', 'windows', 'pdfkiln.iss'), 'utf8'))?.[1];
  if (!appId) throw new Error('no AppId in packaging/windows/pdfkiln.iss');
  const id = 'PDFKiln.PDFKiln';
  const dir = `winget/manifests/p/PDFKiln/PDFKiln/${version}`;
  const head = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.{type}.1.12.0.schema.json\n\nPackageIdentifier: ${id}\nPackageVersion: ${version}\n`;
  out[`${dir}/${id}.yaml`] = `${head.replace('{type}', 'version')}DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.12.0\n`;
  out[`${dir}/${id}.installer.yaml`] = `${head.replace('{type}', 'installer')}InstallerType: inno
Scope: machine
UpgradeBehavior: install
ProductCode: '${appId}_is1'
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

  // Chocolatey: the installer, run silent with its PATH task, as winget
  // runs it; the uninstaller found in the registry by its display name.
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  out['chocolatey/pdfkiln.nuspec'] = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2015/06/nuspec.xsd">
  <metadata>
    <id>pdfkiln</id>
    <version>${version}</version>
    <packageSourceUrl>${REPO}/blob/main/scripts/manifests.ts</packageSourceUrl>
    <owners>Jamalofski</owners>
    <title>PDFKiln</title>
    <authors>Jamal Tantaoui</authors>
    <projectUrl>${SITE}</projectUrl>
    <iconUrl>${SITE}/favicon.svg</iconUrl>
    <licenseUrl>${REPO}/blob/main/LICENSE</licenseUrl>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <projectSourceUrl>${REPO}</projectSourceUrl>
    <docsUrl>${SITE}/migrate/</docsUrl>
    <bugTrackerUrl>${REPO}/issues</bugTrackerUrl>
    <tags>wkhtmltopdf wkhtmltoimage pdf html-to-pdf chromium cli foss</tags>
    <summary>${xml(DESCRIPTION)}</summary>
    <description>${xml(`PDFKiln is a drop-in replacement for wkhtmltopdf, which is archived and has had no release since 2020. Called as \`wkhtmltopdf\` or \`wkhtmltoimage\`, it takes the command lines of wkhtmltopdf and wkhtmltoimage 0.12.6, with the same options, defaults, messages and exit codes, and renders with a current, sandboxed Chromium, updated with each release.

The package runs the official installer. Like wkhtmltopdf's, it installs into \`C:\\Program Files\\wkhtmltopdf\`, the path pdfkit, Rotativa and most guides use, and it adds the \`bin\` folder to the PATH. Uninstall the \`wkhtmltopdf\` package first: both use that folder.

PDFKiln is not affiliated with the wkhtmltopdf project.`)}</description>
    <releaseNotes>${REPO}/releases/tag/${version}</releaseNotes>
  </metadata>
  <files>
    <file src="tools\\**" target="tools" />
  </files>
</package>
`;
  out['chocolatey/tools/chocolateyinstall.ps1'] = `$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = '${url}/${setup}'
  checksum64     = '${sum(setup)}'
  checksumType64 = 'sha256'
  softwareName   = 'pdfkiln*'
  silentArgs     = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /TASKS=addtopath'
  validExitCodes = @(0)
}
Install-ChocolateyPackage @packageArgs
`;
  out['chocolatey/tools/chocolateyuninstall.ps1'] = `$ErrorActionPreference = 'Stop'

[array]$key = Get-UninstallRegistryKey -SoftwareName 'pdfkiln*'
if ($key.Count -eq 1) {
  Uninstall-ChocolateyPackage -PackageName $env:ChocolateyPackageName -FileType 'exe' \`
    -SilentArgs '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -File ($key[0].UninstallString -replace '"', '')
} elseif ($key.Count -eq 0) {
  Write-Warning "$env:ChocolateyPackageName was already uninstalled."
} else {
  Write-Warning "$($key.Count) installations of pdfkiln found: none uninstalled."
}
`;

  // AUR: pdfkiln-bin, from the Linux archives built, laid out as the Debian
  // package lays it out; Chromium's libraries are the Debian package's
  // dependencies under Arch's names. No strip: it would drop the program
  // the single executable carries.
  const linux = ([['x86_64', file('linux-x64', '.tar.gz')], ['aarch64', file('linux-arm64', '.tar.gz')]] as const).filter(([, f]) => sums[f]);
  if (!linux.length) throw new Error('no SHA-256 for a Linux archive');
  const aur = {
    pkgdesc: DESCRIPTION,
    depends: ['alsa-lib', 'at-spi2-core', 'dbus', 'expat', 'fontconfig', 'gcc-libs', 'glib2', 'glibc', 'libx11', 'libxcb', 'libxcomposite',
      'libxdamage', 'libxext', 'libxfixes', 'libxkbcommon', 'libxrandr', 'mesa', 'nspr', 'nss', 'systemd-libs', 'ttf-liberation'],
    provides: ['pdfkiln', 'wkhtmltopdf', 'wkhtmltoimage'],
    conflicts: ['pdfkiln', 'wkhtmltopdf'],
  };
  const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(' ');
  out['aur/PKGBUILD'] = `# Maintainer: Jamal Tantaoui <contact at pdfkiln dot org>
pkgname=pdfkiln-bin
pkgver=${version}
pkgrel=1
pkgdesc='${aur.pkgdesc}'
arch=(${list(linux.map(([a]) => a))})
url='${SITE}'
license=('MIT')
depends=(${list(aur.depends)})
provides=(${list(aur.provides)})
conflicts=(${list(aur.conflicts)})
options=('!strip' '!debug')
${linux.map(([a, f]) => `source_${a}=("${f}::${url}/${f}")
sha256sums_${a}=('${sum(f)}')`).join('\n')}

package() {
  local dir
  case "$CARCH" in
    x86_64) dir="pdfkiln-$pkgver-linux-x64" ;;
    aarch64) dir="pdfkiln-$pkgver-linux-arm64" ;;
  esac
  install -d "$pkgdir/usr/lib/pdfkiln" "$pkgdir/usr/bin"
  cp -a "$dir/pdfkiln" "$dir/chromium" "$pkgdir/usr/lib/pdfkiln/"
  for name in pdfkiln wkhtmltopdf wkhtmltoimage; do
    ln -s ../lib/pdfkiln/pdfkiln "$pkgdir/usr/bin/$name"
  done
  install -Dm644 "$dir/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  cp -a "$dir/licenses/." "$pkgdir/usr/share/licenses/$pkgname/"
  install -Dm644 "$dir/README.txt" "$pkgdir/usr/share/doc/$pkgname/README.txt"
}
`;
  // What makepkg --printsrcinfo writes, which the AUR requires beside it.
  out['aur/.SRCINFO'] = `pkgbase = pdfkiln-bin
\tpkgdesc = ${aur.pkgdesc}
\tpkgver = ${version}
\tpkgrel = 1
\turl = ${SITE}
${linux.map(([a]) => `\tarch = ${a}\n`).join('')}\tlicense = MIT
${aur.depends.map((d) => `\tdepends = ${d}\n`).join('')}${aur.provides.map((p) => `\tprovides = ${p}\n`).join('')}${aur.conflicts.map((c) => `\tconflicts = ${c}\n`).join('')}\toptions = !strip
\toptions = !debug
${linux.map(([a, f]) => `\tsource_${a} = ${f}::${url}/${f}\n\tsha256sums_${a} = ${sum(f)}\n`).join('')}
pkgname = pdfkiln-bin
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
  console.log(`${out}: scoop, winget, homebrew, chocolatey, aur, composer for ${version}`);
}
