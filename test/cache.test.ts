// The cleaning of the user's cache, with the same cases for the npm
// package (src/chromium.ts) and the Composer one
// (packaging/composer/src/launch.php, run by php when there is one).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { platformKey, repoRoot, track } from '../src/chromium.js';

const root = mkdtempSync(join(tmpdir(), 'pdfkiln-cache-'));
after(() => rmSync(root, { recursive: true, force: true }));

interface Side {
  name: string;
  // The versions, oldest first.
  versions: [string, string, string];
  // The folder of a version in the cache, and its program.
  folder(version: string): string;
  program(version: string): string;
  // A download cut short, the trash of an interrupted deletion.
  download: string;
  trash: string;
  // The file a project pins its version in.
  pin: string;
  track(cache: string, project: string, version: string): void;
}

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

const sides: Side[] = [
  {
    name: 'npm',
    versions: ['150.0.7000.1', '151.0.7100.1', '152.0.7200.1'],
    folder: (v) => v,
    program: (v) => join(v, `chrome-headless-shell-${platformKey()}`, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'),
    download: '.download-a1b2c3',
    trash: '.delete-a1b2c3',
    pin: 'chromium.json',
    track,
  },
  {
    name: 'Composer',
    versions: ['1.0.0', '1.1.0', '1.2.0'],
    folder: (v) => `${v}-linux-x64`,
    program: (v) => join(`${v}-linux-x64`, `pdfkiln-${v}-linux-x64`, 'pdfkiln'),
    download: 'tmp-a1b2c3',
    trash: 'delete-a1b2c3',
    pin: 'pins.json',
    track: (cache, project, version) => {
      execFileSync(php, ['-r', 'require $argv[1]; \\Pdfkiln\\track($argv[2], $argv[3], $argv[4]);', '--', launch, cache, project, version], { stdio: 'inherit' });
    },
  },
];

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

// The mtime of a file or folder set back; the access time too with `atime`.
function age(path: string, days: number, atime = true): void {
  utimesSync(path, atime ? ago(days) : statSync(path).atime, ago(days));
}

for (const side of sides) {
  const cases = (name: string, fn: (t: Setup) => void) =>
    test(`${side.name}: ${name}`, { skip: side.name === 'Composer' && !hasPhp && 'no php' }, () => fn(setup(side)));
  const [v0, v1, v2] = side.versions;

  cases('a version no project pins any more goes at once', (t) => {
    t.install(v1);
    const a = t.project('a', v1);
    t.use(a);
    t.pin(a, v2);
    t.use(a);
    t.install(v2);
    assert.equal(t.has(v1), false);
    assert.equal(t.has(v2), true);
  });

  cases('two projects keep each the version it pins', (t) => {
    t.install(v1);
    const a = t.project('a', v1);
    const b = t.project('b', v1);
    t.use(a);
    t.use(b);
    t.pin(b, v2);
    t.use(b);
    t.install(v2);
    assert.equal(t.has(v1), true, 'a still pins it');
    t.pin(a, v2);
    t.use(a);
    assert.equal(t.has(v1), false);
    assert.equal(t.has(v2), true);
  });

  cases('a project out of reach keeps its version 30 days after it last recorded itself', (t) => {
    t.install(v1);
    t.install(v2);
    const a = t.project('a', v1);
    const b = t.project('b', v2);
    t.use(a);
    t.use(b);
    rmSync(a, { recursive: true });
    age(t.record(b), 2);
    t.use(b);
    assert.equal(t.has(v1), true, 'a may only be out of reach (open_basedir)');
    age(t.record(a), 31);
    age(t.record(b), 2);
    t.use(b);
    assert.equal(t.has(v1), false);
    assert.equal(existsSync(t.record(a)), false);
    assert.equal(t.has(v2), true);
  });

  cases('a version no record names goes once it has not run for 30 days', (t) => {
    t.install(v0);
    t.install(v1);
    const a = t.project('a', v1);
    age(t.path(side.program(v0)), 31);
    t.use(a);
    assert.equal(t.has(v0), true, 'installed today');
    age(t.path(side.folder(v0)), 31);
    utimesSync(t.path(side.program(v0)), new Date(), ago(31));
    age(t.record(a), 2);
    t.use(a);
    assert.equal(t.has(v0), true, 'ran today');
    age(t.path(side.program(v0)), 31);
    t.use(a);
    assert.equal(t.has(v0), true, 'cleaned once a day at most');
    age(t.record(a), 2);
    t.use(a);
    assert.equal(t.has(v0), false);
    assert.equal(t.has(v1), true);
  });

  cases('a download cut short goes after a day; other folders stay', (t) => {
    const a = t.project('a', v1);
    for (const f of [side.download, `${side.download}0`, side.trash, 'other', 'run', '1.0']) mkdirSync(t.path(f), { recursive: true });
    age(t.path(side.download), 2);
    t.use(a);
    assert.equal(existsSync(t.path(side.download)), false);
    assert.equal(existsSync(t.path(`${side.download}0`)), true, 'maybe still downloading');
    assert.equal(existsSync(t.path(side.trash)), false);
    for (const f of ['other', 'run', '1.0']) assert.equal(existsSync(t.path(f)), true, f);
  });

  cases('an unreadable record stops the cleaning for 30 days', (t) => {
    t.install(v0);
    t.install(v1);
    const a = t.project('a', v1);
    age(t.path(side.program(v0)), 31);
    age(t.path(side.folder(v0)), 31);
    mkdirSync(t.path('projects'), { recursive: true });
    const broken = t.path('projects', '0123456789abcdef.json');
    writeFileSync(broken, '{"path":');
    t.use(a);
    assert.equal(t.has(v0), true);
    age(broken, 31);
    age(t.record(a), 2);
    t.use(a);
    assert.equal(existsSync(broken), false);
    assert.equal(t.has(v0), false);
  });
}

interface Setup {
  install(version: string): void;
  project(name: string, version: string): string;
  pin(project: string, version: string): void;
  use(project: string): void;
  has(version: string): boolean;
  record(project: string): string;
  path(...parts: string[]): string;
}

let n = 0;
function setup(side: Side): Setup {
  const base = join(root, String(n++));
  const cache = join(base, 'cache');
  const pinned = new Map<string, string>();
  const s: Setup = {
    install(version) {
      const program = join(cache, side.program(version));
      mkdirSync(join(program, '..'), { recursive: true });
      writeFileSync(program, '');
    },
    project(name, version) {
      const dir = join(base, name);
      mkdirSync(dir, { recursive: true });
      s.pin(dir, version);
      return dir;
    },
    pin(project, version) {
      writeFileSync(join(project, side.pin), JSON.stringify({ version }));
      pinned.set(project, version);
    },
    use(project) {
      side.track(cache, project, pinned.get(project)!);
    },
    has: (version) => existsSync(join(cache, side.folder(version))),
    record: (project) => join(cache, 'projects', `${createHash('sha256').update(project).digest('hex').slice(0, 16)}.json`),
    path: (...parts) => join(cache, ...parts),
  };
  mkdirSync(cache, { recursive: true });
  return s;
}
