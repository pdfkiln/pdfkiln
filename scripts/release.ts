// The files of a GitHub release, gathered from the packages of two CI runs (ci.yml,
// arm64.yml) as CI built and tested them, never rebuilt: each one checked
// against the SHA-256 CI wrote next to it, then SHA256SUMS and the release
// notes. Run by .github/workflows/release.yml.
//
//   node dist/scripts/release.js --from <folder of the runs' artifacts> --out <folder>
//     [--notes <file> --repo <owner/name> --commit <sha> --attested --previous-chromium <version>]
//
// Output: the release's files and SHA256SUMS in --out, the notes in --notes,
// which open with the version's section of CHANGELOG.md.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { repoRoot } from '../src/chromium.js';
import { chromiumVersion, version } from '../src/version.js';
import { readSums, REPO } from './manifests.js';

export interface ReleaseFile { file: string; label: string }
export interface Assembled extends ReleaseFile { sha256: string; size: number }

// What a release holds: the installer, the archive of each platform CI
// builds and the Debian packages (revision 1, the one CI builds). Not the
// npm package, which goes to npm.
export function releaseFiles(version: string): ReleaseFile[] {
  const archive = (platform: string, ext: string) => `pdfkiln-${version}-${platform}${ext}`;
  const deb = (arch: string) => `pdfkiln_${version}-1_${arch}.deb`;
  return [
    { file: archive('windows-x64', '-setup.exe'), label: 'Windows x64, installer, in C:\\Program Files\\wkhtmltopdf' },
    { file: archive('windows-x64', '.zip'), label: 'Windows x64, archive: wkhtmltopdf\\bin, as the old installer' },
    { file: deb('amd64'), label: 'Debian and Ubuntu, x64' },
    { file: deb('arm64'), label: 'Debian and Ubuntu, ARM64' },
    { file: archive('linux-x64', '.tar.gz'), label: 'Linux x64, archive' },
    { file: archive('linux-arm64', '.tar.gz'), label: 'Linux ARM64, archive' },
    { file: archive('macos-arm64', '.tar.gz'), label: 'macOS ARM64, archive' },
  ];
}

// The runs' packages, a folder per artifact (each one holds its own npm
// package, under the same name): the folders each file name is in.
function find(from: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const e of readdirSync(from, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) found.set(e.name, [...(found.get(e.name) ?? []), e.parentPath]);
  }
  return found;
}

// Copies each file from the folders under `from` to `out` once its content
// matches the SHA-256 CI wrote next to it; a file missing, found twice,
// without its sum or changed stops it all.
export function assemble(from: string, out: string, files: ReleaseFile[]): Assembled[] {
  rmSync(out, { recursive: true, force: true });
  const found = find(from);
  mkdirSync(out, { recursive: true });
  const assembled = files.map((f) => {
    const dirs = found.get(f.file) ?? [];
    if (!dirs.length) throw new Error(`${f.file} is not among the runs' packages`);
    if (dirs.length > 1) throw new Error(`${f.file} is in several packages: ${dirs.join(', ')}`);
    const sum = readSums(dirs[0]!)[f.file];
    if (!sum) throw new Error(`no SHA-256 for ${f.file}`);
    const path = join(dirs[0]!, f.file);
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (sha256 !== sum) throw new Error(`${f.file} does not match the SHA-256 CI wrote`);
    copyFileSync(path, join(out, f.file));
    return { ...f, sha256, size: statSync(path).size };
  });
  const sorted = [...assembled].sort((a, b) => (a.file < b.file ? -1 : 1));
  writeFileSync(join(out, 'SHA256SUMS'), sorted.map((a) => `${a.sha256}  ${a.file}\n`).join(''));
  return assembled;
}

export interface Origin { repo: string; commit: string; attested: boolean }

// The section of CHANGELOG.md for `version`, from its "## <version>" heading
// to the next one: none, or an empty one, stops the release.
export function changes(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const section = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  if (!section) throw new Error(`CHANGELOG.md: the "## ${version}" section is empty`);
  return section;
}

// What changed first: Chromium's version when the release changes it
// (`previous`: the Chromium of the latest release, empty for the first),
// the only time the notes name it, then the changelog's lines; then the
// files; what PDFKiln is, last, for those who land here.
export function notes(version: string, chromium: string, previous: string, changed: string, origin: Origin, files: Assembled[]): string {
  const url = `https://github.com/${origin.repo}`;
  const newChromium = previous !== '' && previous !== chromium;
  if (!newChromium && /\bChromium\b/.test(changed)) {
    throw new Error(`CHANGELOG.md: the "## ${version}" section names Chromium, which ${version} does not change`);
  }
  return `## Changes in ${version}

${newChromium ? `- Chromium ${chromium}, from ${previous}.\n` : ''}${changed}

## Files

| File | For | Size |
| --- | --- | --- |
${files.map((f) => `| \`${f.file}\` | ${f.label} | ${(f.size / 1e6).toFixed(1)} MB |`).join('\n')}

Built and tested by CI (\`ci.yml\`, \`arm64.yml\`) from commit [${origin.commit.slice(0, 7)}](${url}/commit/${origin.commit}).

- Checksums: \`sha256sum -c SHA256SUMS --ignore-missing\`
${origin.attested ? `- Provenance: \`gh attestation verify <file> --repo ${origin.repo}\`\n` : ''}
PDFKiln is a drop-in replacement for wkhtmltopdf: called as \`wkhtmltopdf\` or \`wkhtmltoimage\`, it accepts the command line of wkhtmltopdf 0.12.6. Installation and migration: [README](${url}/blob/${origin.commit}/README.md). Not affiliated with the wkhtmltopdf project.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      out: { type: 'string' },
      notes: { type: 'string' },
      repo: { type: 'string', default: REPO.replace('https://github.com/', '') },
      commit: { type: 'string', default: '' },
      attested: { type: 'boolean', default: false },
      'previous-chromium': { type: 'string', default: '' },
    },
  });
  if (!values.from || !values.out) throw new Error('--from <folder of the runs\' artifacts> and --out <folder> are required');
  const changed = values.notes ? changes(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), version) : '';
  const files = assemble(values.from, values.out, releaseFiles(version));
  if (values.notes) {
    const origin = { repo: values.repo, commit: values.commit, attested: values.attested };
    writeFileSync(values.notes, notes(version, chromiumVersion, values['previous-chromium'], changed, origin, files));
  }
  for (const f of files) console.log(`${f.file} ${(f.size / 1e6).toFixed(1)} MB ${f.sha256}`);
}
