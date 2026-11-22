// The first use of the npm package (src/chromium.ts) and of the Composer
// one (packaging/composer/src/launch.php, run by php when there is one),
// against a local server: a version's folder that lost its program is
// installed again, once, and a download cut short says so.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { installChromium, platformKey, repoRoot } from '../src/chromium.js';

const root = mkdtempSync(join(tmpdir(), 'pdfkiln-install-'));
const served = join(root, 'served');
mkdirSync(served);

// /<file> serves a file of `served`; /cut/<file> announces its whole length
// but stops halfway, as a dropped connection. `requests` counts the downloads.
let requests = 0;
const server = createServer((req, res) => {
  const m = /^\/(cut\/)?([\w.-]+)$/.exec(req.url ?? '');
  const file = m ? join(served, m[2]!) : '';
  if (!m || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  requests++;
  const data = readFileSync(file);
  res.writeHead(200, { 'Content-Length': data.length });
  if (m[1]) res.write(data.subarray(0, data.length >> 1), () => res.destroy());
  else res.end(data);
});
let base = '';
before(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
let n = 0;

// A zip of stored files, "made on Unix" as Chrome for Testing's.
function zip(entries: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [entry, data] of Object.entries(entries)) {
    const name = Buffer.from(entry);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

// What a download leaves next to the versions while it runs or is deleted.
const leftovers = (dir: string) => readdirSync(dir).filter((f) => /^\.?(download|delete|tmp)-/.test(f));

// npm: a Chrome for Testing archive, 3 MB so that half of it shows.
function chromium(): { archive: { file: string; size: number; sha256: string }; target: string; exe: string } {
  const folder = `chrome-headless-shell-${platformKey()}`;
  const name = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  const data = zip({ [`${folder}/${name}`]: Buffer.from('fake'), [`${folder}/padding.bin`]: randomBytes(3_000_000) });
  const file = `chromium-${n++}.zip`;
  writeFileSync(join(served, file), data);
  const target = join(root, `npm-${n}`, 'chromium', '158.0.8127.36');
  return { archive: { file, size: data.length, sha256: sha256(data) }, target, exe: join(target, folder, name) };
}

test('npm: a version folder that lost its program is installed again, once', async () => {
  const { archive, target, exe } = chromium();
  const url = `${base}/${archive.file}`;
  const first = requests;
  assert.equal(await installChromium(url, archive, target, exe), exe);
  rmSync(exe);
  assert.equal(await installChromium(url, archive, target, exe), exe);
  assert.equal(existsSync(exe), true);
  assert.equal(await installChromium(url, archive, target, exe), exe);
  assert.equal(requests - first, 2, 'one download for the install, one for the repair');
  assert.deepEqual(leftovers(dirname(target)), []);
});

test('npm: a download cut short says so', async () => {
  const { archive, target, exe } = chromium();
  await assert.rejects(installChromium(`${base}/cut/${archive.file}`, archive, target, exe), /stopped at 1 of 3 MB: run it again/);
  assert.equal(existsSync(target), false);
  assert.deepEqual(leftovers(dirname(target)), []);
});

const php = process.env.PDFKILN_TEST_PHP ?? 'php';
const hasPhp = (() => {
  try {
    execFileSync(php, ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const launch = join(repoRoot, 'packaging', 'composer', 'src', 'launch.php');
const composer = { skip: !hasPhp && 'no php' };

// Composer: the archive of the platform php runs on, as scripts/package.ts
// lays it out, 3 MB so that half of it shows.
function release(version: string): { file: string; sha: string } {
  const platform = execFileSync(php, ['-r', 'require $argv[1]; echo \\Pdfkiln\\platform();', '--', launch]).toString();
  const padding = randomBytes(3_000_000);
  const file = `pdfkiln-${version}-${platform}${platform === 'windows-x64' ? '.zip' : '.tar.gz'}`;
  if (platform === 'windows-x64') {
    writeFileSync(join(served, file), zip({ 'wkhtmltopdf/bin/pdfkiln.exe': Buffer.from('fake'), 'wkhtmltopdf/bin/padding.bin': padding }));
  } else {
    const staging = mkdtempSync(join(root, 'staging-'));
    const folder = join(staging, `pdfkiln-${version}-${platform}`);
    mkdirSync(folder);
    writeFileSync(join(folder, 'pdfkiln'), 'fake');
    writeFileSync(join(folder, 'padding.bin'), padding);
    execFileSync('tar', ['-czf', join(served, file), '-C', staging, `pdfkiln-${version}-${platform}`]);
  }
  return { file, sha: sha256(readFileSync(join(served, file))) };
}

// \Pdfkiln\ensure() for the program pdfkiln: its path, or "error: " and the
// message it raises.
async function ensure(dist: string, url: string, version: string, file: string, sha: string): Promise<string> {
  const code = 'require $argv[1]; try { echo \\Pdfkiln\\ensure(["version" => $argv[4], "url" => $argv[3], "sha256" => [$argv[5] => $argv[6]]], \\Pdfkiln\\platform(), $argv[2], "pdfkiln"); } catch (RuntimeException $e) { echo "error: ", $e->getMessage(); }';
  return (await promisify(execFile)(php, ['-r', code, '--', launch, dist, url, version, file, sha])).stdout;
}

test('Composer: a version folder that lost its program is installed again, once', composer, async () => {
  const { file, sha } = release('9.9.1');
  const dist = join(root, 'composer-a', 'dist');
  const first = requests;
  const exe = await ensure(dist, base, '9.9.1', file, sha);
  assert.equal(existsSync(exe), true, exe);
  rmSync(exe);
  assert.equal(await ensure(dist, base, '9.9.1', file, sha), exe);
  assert.equal(existsSync(exe), true);
  assert.equal(await ensure(dist, base, '9.9.1', file, sha), exe);
  assert.equal(requests - first, 2, 'one download for the install, one for the repair');
  assert.deepEqual(leftovers(dist), []);
});

test('Composer: a download cut short says so', composer, async () => {
  const { file, sha } = release('9.9.2');
  const dist = join(root, 'composer-b', 'dist');
  assert.match(await ensure(dist, `${base}/cut`, '9.9.2', file, sha), /^error: pdfkiln: the download of \S+ stopped at 1 of 3 MB: run it again$/);
  assert.deepEqual(readdirSync(dist), []);
});
