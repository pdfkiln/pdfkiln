// Where chrome-headless-shell is: next to the program once installed,
// in the repository's .cache when developing (npm run fetch:chromium), in
// the user's cache for the npm package, which downloads it on first use.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { extractZip } from './engine/unzip.js';
import { chromiumVersion } from './version.js';

export interface ChromiumPin {
  product: string;
  channel: string;
  version: string;
  source: string;
  archives: Record<string, { file: string; size: number; sha256: string }>;
}

// dist/src when compiled, dist/bundle when bundled: two levels below the
// repository either way.
const here = typeof __dirname === 'string' ? __dirname : import.meta.dirname;
export const repoRoot = resolve(here, '..', '..');

export function readPin(): ChromiumPin {
  return JSON.parse(readFileSync(join(repoRoot, 'chromium.json'), 'utf8')) as ChromiumPin;
}

// Chrome for Testing platform names.
export function platformKey(): string {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return 'linux64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (platform === 'win32') return arch === 'ia32' ? 'win32' : 'win64';
  throw new Error(`No chrome-headless-shell build for ${platform}-${arch}`);
}

export function installDir(version = chromiumVersion): string {
  return join(repoRoot, '.cache', 'chromium', version);
}

const exeName = () => (process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');

// The single executable: Node's sea module says so.
function isSea(): boolean {
  try {
    return typeof require === 'function' && (require('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

// PDFKILN_CACHE_DIR, or the platform's cache folder.
export function userCacheDir(): string {
  if (process.env.PDFKILN_CACHE_DIR) return process.env.PDFKILN_CACHE_DIR;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'pdfkiln');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'pdfkiln');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pdfkiln');
}

const userInstall = () => join(userCacheDir(), 'chromium', chromiumVersion, `chrome-headless-shell-${platformKey()}`, exeName());

export function executablePath(): string {
  if (process.env.PDFKILN_CHROMIUM) return process.env.PDFKILN_CHROMIUM;
  const app = join(isSea() ? dirname(process.execPath) : here, 'chromium', exeName());
  const dev = join(installDir(), `chrome-headless-shell-${platformKey()}`, exeName());
  for (const c of [app, dev]) if (existsSync(c)) return c;
  // The user's cache only now: an account without a profile, such as an
  // IIS application pool's, may have no home folder Node can read.
  const user = userInstall();
  return existsSync(user) || !isSea() ? user : app;
}

// The executable, downloaded first when the program has none: the npm
// package, which ships chromium.json only. The archive is checked against
// its SHA-256 and unpacked aside, then moved in place: two first calls at
// once both succeed.
export async function ensureChromium(): Promise<string> {
  const exe = executablePath();
  if (process.env.PDFKILN_CHROMIUM || isSea()) return exe;
  if (exe === userInstall()) {
    try {
      track(join(userCacheDir(), 'chromium'), repoRoot, chromiumVersion);
    } catch {
      // The cache stays as it is: never a reason to fail a conversion.
    }
  }
  if (existsSync(exe)) return exe;
  const pin = readPin();
  const key = platformKey();
  const archive = pin.archives[key];
  if (!archive) throw new Error(`chromium.json has no archive for ${key}`);
  const url = `${pin.source}/${pin.version}/${key}/${archive.file}`;
  const target = join(userCacheDir(), 'chromium', pin.version);
  process.stderr.write(`pdfkiln: first use, downloading Chromium ${pin.version} (${Math.round(archive.size / 1e6)} MB) into ${target}\n`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = mkdtempSync(join(dirname(target), '.download-'));
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
    const zip = join(tmp, archive.file);
    const hash = createHash('sha256');
    const out = createWriteStream(zip);
    for await (const chunk of Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)) {
      hash.update(chunk as Buffer);
      if (!out.write(chunk)) await new Promise<void>((ok) => out.once('drain', () => ok()));
    }
    out.end();
    await finished(out);
    const sha = hash.digest('hex');
    if (sha !== archive.sha256) throw new Error(`${url}: SHA-256 mismatch, expected ${archive.sha256}, got ${sha}`);
    extractZip(zip, join(tmp, 'chromium'));
    try {
      renameSync(join(tmp, 'chromium'), target);
    } catch (e) {
      if (!existsSync(exe)) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return exe;
}

const day = 86_400_000;

interface UseRecord { path?: string; version?: string }

// The cache keeps each Chromium in chromium/<version>/, about 280 MB.
// Each package that uses it records its folder and version in
// chromium/projects/, when that version changes and at most once a day; the
// cache is cleaned then (packaging/composer/src/launch.php does the same):
// - a version that no recorded package pins any more goes at once;
// - a package whose folder cannot be read (gone, or out of this account's
//   reach) keeps its version until 30 days after it last recorded itself;
// - a version that no record names, left by pdfkiln 1.1.0 or earlier,
//   goes once it has not run for 30 days;
// - a download cut short goes after a day.
// Several projects of one account, on different versions, never take each
// other's Chromium away.
export function track(cache: string, project: string, version: string): void {
  const projects = join(cache, 'projects');
  const record = join(projects, `${createHash('sha256').update(project).digest('hex').slice(0, 16)}.json`);
  let previous: string | undefined;
  try {
    const v = (JSON.parse(readFileSync(record, 'utf8')) as UseRecord).version;
    if (typeof v === 'string') previous = v;
  } catch {
    // Not recorded yet.
  }
  if (previous === version && Date.now() - mtime(record) < day) return;
  mkdirSync(projects, { recursive: true });
  const tmp = `${record}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify({ path: project, version }));
  try {
    renameSync(tmp, record);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  clean(cache, previous);
}

function clean(cache: string, previous: string | undefined): void {
  const now = Date.now();
  const used = new Set<string>();
  const known = new Set<string>(previous ? [previous] : []);
  const projects = join(cache, 'projects');
  for (const f of readdirSync(projects)) {
    const record = join(projects, f);
    const age = now - mtime(record);
    // A record whose writing was cut short.
    if (!/^[0-9a-f]{16}\.json$/.test(f)) {
      if (age > day) remove(record);
      continue;
    }
    let r: UseRecord = {};
    try {
      r = JSON.parse(readFileSync(record, 'utf8')) as UseRecord;
    } catch {
      // Unreadable: while it may still be a project's, nothing is cleaned.
    }
    if (typeof r.path !== 'string' || typeof r.version !== 'string') {
      if (age < 30 * day) return;
      remove(record);
      continue;
    }
    const pinned = pinnedVersion(r.path);
    if (pinned) {
      used.add(pinned);
      known.add(r.version);
    } else if (age < 30 * day) {
      used.add(r.version);
    } else {
      known.add(r.version);
      remove(record);
    }
  }
  for (const f of readdirSync(cache)) {
    const p = join(cache, f);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(f)) {
      if (!used.has(f) && (known.has(f) || now - lastRun(p) > 30 * day)) discard(cache, p);
    } else if (f.startsWith('.delete-') || (f.startsWith('.download-') && now - mtime(p) > day)) {
      remove(p);
    }
  }
}

function pinnedVersion(project: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(join(project, 'chromium.json'), 'utf8')) as ChromiumPin).version;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

function mtime(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

// When a version's Chromium last ran: the access time of its program, where
// the system keeps it, and never earlier than its install.
function lastRun(dir: string): number {
  const exe = statSync(join(dir, `chrome-headless-shell-${platformKey()}`, exeName()), { throwIfNoEntry: false });
  return Math.max(exe?.atimeMs ?? 0, mtime(dir));
}

// Renamed, then deleted: the version's folder is whole or gone, never half
// there. What a running process still holds goes the next time.
function discard(cache: string, dir: string): void {
  const trash = join(cache, `.delete-${randomBytes(6).toString('hex')}`);
  try {
    renameSync(dir, trash);
  } catch {
    return;
  }
  remove(trash);
}

function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Held by a running process (Windows): the next time.
  }
}
