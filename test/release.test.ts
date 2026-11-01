// The release's files, checked against the sums CI wrote, and its notes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assemble, changes, notes, releaseFiles } from '../scripts/release.js';

const files = releaseFiles('1.2.3');

// The runs' artifacts as release.yml downloads them, a folder each: files
// with their .sha256, and the npm package in every one.
const artifacts: Record<string, RegExp> = {
  'package-windows-2025': /windows/,
  'package-ubuntu-24.04': /linux-x64|amd64/,
  'package-linux-arm64': /linux-arm64|_arm64/,
  'package-macos-15': /macos/,
};

function packages(): string {
  const from = mkdtempSync(join(tmpdir(), 'pdfkiln-release-'));
  for (const [artifact, mine] of Object.entries(artifacts)) {
    const dir = join(from, artifact);
    mkdirSync(dir);
    for (const { file } of files.filter((f) => mine.test(f.file))) {
      writeFileSync(join(dir, file), file);
      const sha = createHash('sha256').update(file).digest('hex');
      // PowerShell writes the installer's with CRLF.
      writeFileSync(join(dir, `${file}.sha256`), `${sha}  ${file}${file.endsWith('.exe') ? '\r\n' : '\n'}`);
    }
    writeFileSync(join(dir, 'pdfkiln-pdfkiln-1.2.3.tgz'), artifact);
  }
  return from;
}

test('the files of every platform', () => {
  assert.deepEqual(files.map((f) => f.file), [
    'pdfkiln-1.2.3-windows-x64-setup.exe',
    'pdfkiln-1.2.3-windows-x64.zip',
    'pdfkiln_1.2.3-1_amd64.deb',
    'pdfkiln_1.2.3-1_arm64.deb',
    'pdfkiln-1.2.3-linux-x64.tar.gz',
    'pdfkiln-1.2.3-linux-arm64.tar.gz',
    'pdfkiln-1.2.3-macos-arm64.tar.gz',
  ]);
});

test('files checked against their sums, copied, and SHA256SUMS written', () => {
  const from = packages();
  const out = join(from, 'release');
  try {
    const assembled = assemble(from, out, files);
    assert.deepEqual(readdirSync(out).sort(), [...files.map((f) => f.file), 'SHA256SUMS'].sort());
    const lines = readFileSync(join(out, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, files.length);
    assert.match(lines[0]!, /^[0-9a-f]{64} {2}pdfkiln-1\.2\.3-linux-arm64\.tar\.gz$/);
    assert.equal(assembled[0]!.size, files[0]!.file.length);
  } finally {
    rmSync(from, { recursive: true, force: true });
  }
});

test('a file missing, changed since CI or found twice stops the release', () => {
  const from = packages();
  const ubuntu = join(from, 'package-ubuntu-24.04');
  try {
    writeFileSync(join(ubuntu, files[2]!.file), 'changed');
    assert.throws(() => assemble(from, join(from, 'release'), files), /amd64\.deb does not match the SHA-256 CI wrote/);
    rmSync(join(ubuntu, files[2]!.file));
    assert.throws(() => assemble(from, join(from, 'release'), files), /amd64\.deb is not among the runs' packages/);
    rmSync(join(from, 'package-linux-arm64', `${files[3]!.file}.sha256`));
    assert.throws(() => assemble(from, join(from, 'release'), files.slice(3)), /no SHA-256 for \S+arm64\.deb/);
    writeFileSync(join(ubuntu, files[6]!.file), files[6]!.file);
    assert.throws(() => assemble(from, join(from, 'release'), files.slice(6)), /macos-arm64\.tar\.gz is in several packages/);
  } finally {
    rmSync(from, { recursive: true, force: true });
  }
});

test('changes: the version\'s section of the changelog, none or an empty one refused', () => {
  const changelog = '# Changes\n\nIntro.\n\n## 1.2.4\n\n- Later.\n\n## 1.2.3\n\n- Fixed this.\n- And that.\n\n## 1.2.2\n\n- Earlier.\n\n## 1.2.1\n';
  assert.equal(changes(changelog, '1.2.3'), '- Fixed this.\n- And that.');
  assert.equal(changes(changelog.replace(/\n/g, '\r\n'), '1.2.2'), '- Earlier.');
  assert.throws(() => changes(changelog, '1.2.5'), /no "## 1\.2\.5" section/);
  assert.throws(() => changes(changelog, '1.2.1'), /"## 1\.2\.1" section is empty/);
  assert.throws(() => changes(changelog, '1.2'), /no "## 1\.2" section/);
});

test('notes: Chromium named only when the release changes it, first', () => {
  const origin = { repo: 'owner/pdfkiln', commit: 'abcdef0123456789', attested: false };
  const text = notes('1.2.3', '156.0.8078.73', '156.0.8078.47', '- Fixed this.', origin, []);
  assert.match(text, /^## Changes in 1\.2\.3\n\n- Chromium 156\.0\.8078\.73, from 156\.0\.8078\.47\.\n- Fixed this\.\n\n## Files\n/);
  assert.ok(text.indexOf('## Files') < text.indexOf('PDFKiln is a drop-in replacement for wkhtmltopdf'));
  // The same Chromium, or the first release: not a word of it.
  for (const previous of ['156.0.8078.73', '']) {
    const same = notes('1.2.3', '156.0.8078.73', previous, '- Fixed this.', origin, []);
    assert.match(same, /^## Changes in 1\.2\.3\n\n- Fixed this\.\n\n## Files\n/);
    assert.doesNotMatch(same, /Chromium/);
  }
  assert.throws(() => notes('1.2.3', '156.0.8078.73', '156.0.8078.73', '- Chromium starts faster.', origin, []), /"## 1\.2\.3" section names Chromium, which 1\.2\.3 does not change/);
  assert.match(notes('1.2.3', '156.0.8078.73', '156.0.8078.73', '- `PDFKILN_CHROMIUM` and chromium.json.', origin, []), /PDFKILN_CHROMIUM/);
});

test('notes: the files, the commit CI built them from, provenance once attested', () => {
  const assembled = files.map((f) => ({ ...f, sha256: '0'.repeat(64), size: 158_200_000 }));
  const origin = { repo: 'owner/pdfkiln', commit: 'abcdef0123456789', attested: false };
  const text = notes('1.2.3', '156.0.8078.47', '156.0.8078.47', '- Fixed this.', origin, assembled);
  assert.match(text, /\| `pdfkiln-1\.2\.3-windows-x64-setup\.exe` \| Windows x64, installer, in C:\\Program Files\\wkhtmltopdf \| 158\.2 MB \|/);
  assert.match(text, /\nBuilt and tested by CI \(`ci\.yml`, `arm64\.yml`\) from commit \[abcdef0\]\(https:\/\/github\.com\/owner\/pdfkiln\/commit\/abcdef0123456789\)\.\n/);
  // A run's logs go after 90 days: no link to one.
  assert.doesNotMatch(text, /actions\/runs/);
  assert.doesNotMatch(text, /attestation/);
  assert.match(notes('1.2.3', '156.0.8078.47', '156.0.8078.47', '- Fixed this.', { ...origin, attested: true }, assembled), /gh attestation verify <file> --repo owner\/pdfkiln/);
});
