// What wkhtmltopdf writes on stderr and how it exits.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { executablePath } from '../src/chromium.js';
import { addressSpace, appArmorRestricts, chromiumCommand, explain, parseLdd, runsAsRoot, systemdUnit, userNamespaces } from '../src/engine/browser.js';
import { Feedback } from '../src/wk/feedback.js';
import { handleError, qtErrorForHttpStatus, qtErrorString } from '../src/wk/qtnet.js';

// Both commands on one page, as cli.test.ts runs them: from dist/src, the
// bundle (PDFKILN_TEST_BUNDLE=1) or a package's programs
// (PDFKILN_TEST_WKHTMLTOPDF, PDFKILN_TEST_PDFKILN).
function convert(name: 'wkhtmltopdf' | 'pdfkiln', args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'pdfkiln-test-'));
  try {
    writeFileSync(join(dir, 'page.html'), '<p>Sandbox</p>');
    const root = resolve(import.meta.dirname, '..', '..');
    const script = process.env.PDFKILN_TEST_BUNDLE ? join(root, 'dist', 'bundle', `${name}.cjs`) : join(root, 'dist', 'src', 'bin', `${name}.js`);
    const exe = name === 'wkhtmltopdf' ? process.env.PDFKILN_TEST_WKHTMLTOPDF : process.env.PDFKILN_TEST_PDFKILN;
    const r = spawnSync(exe ?? process.execPath, [...(exe ? [] : [script]), ...args, 'page.html', 'page.pdf'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
    return { code: r.status, stderr: r.stderr, pdf: existsSync(join(dir, 'page.pdf')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('exit codes, measured on wkhtmltopdf 0.12.6', () => {
  // An HTTP 404 reaches wkhtmltopdf as Qt's ContentNotFoundError: exit 1.
  assert.deepEqual(handleError(true, 1000 + qtErrorForHttpStatus(404)), { code: 1, line: 'Exit with code 1 due to network error: ContentNotFoundError' });
  assert.deepEqual(handleError(true, 1000 + qtErrorForHttpStatus(401)), { code: 1, line: 'Exit with code 1 due to network error: AuthenticationRequiredError' });
  assert.deepEqual(handleError(true, 1000 + qtErrorForHttpStatus(500)), { code: 1, line: 'Exit with code 1 due to network error: UnknownContentError' });
  assert.deepEqual(handleError(false, 0), { code: 1, line: 'Exit with code 1, due to unknown error.' });
  assert.deepEqual(handleError(true, 0), { code: 0 });
  // What the code of wkhtmltopdf would do with a bare HTTP status.
  assert.deepEqual(handleError(true, 404), { code: 2, line: 'Exit with code 2 due to http error: 404 Page not found' });
});

test('a host not found: named over http, not over https, as Qt 4.8 does', () => {
  // wkhtmltopdf 0.12.6, Linux and Windows (31/10/2026).
  assert.equal(qtErrorString(3, 'http://pdfkiln-nonexistent.invalid/', 0, ''), 'Host pdfkiln-nonexistent.invalid not found');
  assert.equal(qtErrorString(3, 'https://pdfkiln-nonexistent.invalid/', 0, ''), 'Host  not found');
  assert.equal(qtErrorString(3, 'https://codebeat.co/badges/a6bb7f66', 0, ''), 'Host  not found');
});

test('Chromium that does not start: the reason, with the fix', () => {
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  assert.equal(explain(closed), `Chromium did not start: ${closed}`);
  assert.equal(explain(closed, { serverCore: () => false }), `Chromium did not start: ${closed}`);
  assert.match(explain(closed, { serverCore: () => true }), /^Chromium does not run on Windows Server Core: .* Desktop Experience/);
});

test('as root, Chromium refuses its sandbox: told from the user ID, with the option of each command', () => {
  // All Puppeteer says of Chromium 158 run as root (Debian 13, 25/11/2026):
  // Chromium's own line stays on its stderr.
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  const root = { root: () => true };
  assert.equal(explain(closed, root), 'Chromium refuses to run as root with its sandbox on. Run the command as an unprivileged user (or pass --kiln-no-sandbox, not recommended).');
  assert.equal(explain(closed, root, '--no-sandbox'), 'Chromium refuses to run as root with its sandbox on. Run the command as an unprivileged user (or pass --no-sandbox, not recommended).');
  assert.equal(explain(closed, { root: () => false }), `Chromium did not start: ${closed}`);
  // Chromium checks the user before the sandbox: root in a container, whose
  // namespaces are refused too, is told first.
  assert.match(explain(closed, { ...root, appArmor: () => '/c/chrome', namespaces: () => false }), /refuses to run as root/);
  // A library it lacks stops it before.
  assert.match(explain(closed, { ...root, missing: () => ['libasound.so.2'] }), /lacks libasound\.so\.2/);
  if (process.platform !== 'linux') assert.equal(runsAsRoot(), false);
});

test('Chromium that lacks a system library: named, from ldd', () => {
  // Lines of ldd for chrome-headless-shell 156 on Ubuntu 24.04 (WSL), without
  // libasound2t64 (28/10/2026); a library may come twice.
  const ldd = [
    '\tlinux-vdso.so.1 (0x00007ffd315df000)',
    '\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007fbe5a23d000)',
    '\tlibnspr4.so => /lib/x86_64-linux-gnu/libnspr4.so (0x00007fbe5a04d000)',
    '\tlibasound.so.2 => not found',
    '\tlibasound.so.2 => not found',
  ].join('\n');
  assert.deepEqual(parseLdd(ldd), ['libasound.so.2']);
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  assert.match(explain(closed, { missing: () => parseLdd(ldd) }), /^Chromium cannot start: the system lacks libasound\.so\.2\. The Debian package/);
  assert.match(explain(closed, { missing: () => ['libasound.so.2', 'libgbm.so.1'] }), /lacks libasound\.so\.2, libgbm\.so\.1\./);
  assert.equal(explain(closed, { missing: () => [] }), `Chromium did not start: ${closed}`);
});

test('a cap on the address space: a soft one raised, a hard one explained', () => {
  // /proc/self/limits of a process Odoo 20 starts (limit_memory_hard, 01/11/2026).
  const odoo = [
    'Limit                     Soft Limit           Hard Limit           Units     ',
    'Max cpu time              unlimited            unlimited            seconds   ',
    'Max address space         2684354560           unlimited            bytes     ',
  ].join('\n');
  assert.deepEqual(addressSpace(odoo), { soft: 2684354560, hard: Infinity });
  assert.deepEqual(addressSpace('Max address space         unlimited            unlimited            bytes'), { soft: Infinity, hard: Infinity });
  assert.equal(addressSpace(''), null);
  const args = ['--headless', '--remote-debugging-pipe'];
  assert.deepEqual(chromiumCommand('/c/chrome', args, null), ['/c/chrome', args]);
  assert.deepEqual(chromiumCommand('/c/chrome', args, { soft: Infinity, hard: Infinity }), ['/c/chrome', args]);
  assert.deepEqual(chromiumCommand('/c/chrome', args, addressSpace(odoo)), ['/bin/sh', ['-c', 'ulimit -S -v "$(ulimit -H -v)"; exec "$0" "$@"', '/c/chrome', ...args]]);
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  assert.equal(explain(closed, { space: () => ({ soft: 2684354560, hard: Infinity }) }), `Chromium did not start: ${closed}`);
  assert.match(explain(closed, { space: () => ({ soft: 2684354560, hard: 2684354560 }) }), /^Chromium cannot start under a cap on its address space \(ulimit -v, RLIMIT_AS\) of 2560 MiB: .* LimitAS=infinity/);
});

test('a system that refuses user namespaces: the sandbox, and the seccomp profile', () => {
  // Under Docker's default seccomp profile, Chromium only says this (Odoo's
  // official image, 01/11/2026).
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  const refused = (namespaces: boolean | null, option?: string) => explain(closed, { namespaces: () => namespaces }, option);
  assert.match(refused(false), /^Chromium's sandbox cannot start: this system refuses the user namespaces it needs\. In a container, run it with PDFKiln's seccomp profile \(docker run --security-opt seccomp=seccomp\.json, from https:\/\/raw\.githubusercontent\.com\/pdfkiln\/pdfkiln\/main\/docker\/seccomp\.json\).* --kiln-no-sandbox works around it, not recommended\.$/);
  assert.match(refused(false, '--no-sandbox'), / --no-sandbox works around it, not recommended\.$/);
  assert.equal(refused(true), `Chromium did not start: ${closed}`);
  assert.equal(refused(null), `Chromium did not start: ${closed}`);
});

test('a systemd unit that refuses user namespaces: named, with the drop-in that allows those of the sandbox', () => {
  // php8.5-fpm 8.5.13 of packages.sury.org, Debian 13, whose unit has the
  // hardening of PHP's own, RestrictNamespaces=true among it (25/11/2026).
  const status = 'Name:\tnode\nNoNewPrivs:\t0\nSeccomp:\t2\nSeccomp_filters:\t4\n';
  const files: Record<string, string> = { '/proc/self/status': status, '/proc/self/cgroup': '0::/system.slice/php8.5-fpm.service\n' };
  const read = (p: string) => files[p] ?? null;
  assert.deepEqual(systemdUnit(read), { name: 'php8.5-fpm.service', user: false });
  // Under cgroup v1, systemd's own hierarchy, with or without the unified one.
  files['/proc/self/cgroup'] = '12:pids:/system.slice/php-fpm.service\n1:name=systemd:/system.slice/php-fpm.service\n';
  assert.deepEqual(systemdUnit(read), { name: 'php-fpm.service', user: false });
  files['/proc/self/cgroup'] = '1:name=systemd:/system.slice/php-fpm.service\n0::/\n';
  assert.deepEqual(systemdUnit(read), { name: 'php-fpm.service', user: false });
  // A template's instance, and a unit of a user's own manager.
  files['/proc/self/cgroup'] = '0::/system.slice/system-worker.slice/worker@2.service\n';
  assert.deepEqual(systemdUnit(read), { name: 'worker@2.service', user: false });
  files['/proc/self/cgroup'] = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/queue.service\n';
  assert.deepEqual(systemdUnit(read), { name: 'queue.service', user: true });
  // A shell over SSH, a terminal, a container (Docker, Kubernetes): a scope
  // or the root of the group, never a service.
  for (const cgroup of ['0::/user.slice/user-1000.slice/session-3.scope', '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1.scope', '0::/', '0::/system.slice/docker-4f1e.scope', '1:name=systemd:/docker/4f1e', '0::/system.slice/dev-disk-by\\x2duuid-1.service']) {
    files['/proc/self/cgroup'] = `${cgroup}\n`;
    assert.equal(systemdUnit(read), null, cgroup);
  }
  // Without a seccomp filter, the unit refuses nothing: the kernel does.
  files['/proc/self/cgroup'] = '0::/system.slice/cron.service\n';
  files['/proc/self/status'] = status.replace('Seccomp:\t2', 'Seccomp:\t0');
  assert.equal(systemdUnit(read), null);
  assert.equal(systemdUnit(() => null), null);
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  const seccomp = "In a container, run it with PDFKiln's seccomp profile (docker run --security-opt seccomp=seccomp.json, from https://raw.githubusercontent.com/pdfkiln/pdfkiln/main/docker/seccomp.json); elsewhere, allow unprivileged user namespaces (user.max_user_namespaces, kernel.unprivileged_userns_clone).";
  const fpm = { namespaces: () => false, unit: () => ({ name: 'php8.5-fpm.service', user: false }) };
  assert.equal(explain(closed, fpm), `Chromium's sandbox cannot start: this system refuses the user namespaces it needs. PDFKiln runs in the systemd unit php8.5-fpm.service, whose RestrictNamespaces= may refuse them: run systemctl edit php8.5-fpm.service, add the lines [Service] and RestrictNamespaces=user pid net, the three namespaces the sandbox needs, then systemctl restart php8.5-fpm.service. ${seccomp} --kiln-no-sandbox works around it, not recommended.`);
  assert.match(explain(closed, fpm, '--no-sandbox'), / --no-sandbox works around it, not recommended\.$/);
  assert.match(explain(closed, { namespaces: () => false, unit: () => ({ name: 'queue.service', user: true }) }), /: run systemctl --user edit queue\.service, .* then systemctl --user restart queue\.service\. In a container/);
  // Outside a unit, or where namespaces are allowed, as before.
  assert.equal(explain(closed, { namespaces: () => false, unit: () => null }), `Chromium's sandbox cannot start: this system refuses the user namespaces it needs. ${seccomp} --kiln-no-sandbox works around it, not recommended.`);
  assert.equal(explain(closed, { namespaces: () => true, unit: fpm.unit }), `Chromium did not start: ${closed}`);
  // Root and AppArmor come before.
  assert.match(explain(closed, { ...fpm, root: () => true }), /refuses to run as root/);
  assert.match(explain(closed, { ...fpm, appArmor: () => '/c/chrome' }), /AppArmor/);
});

test('AppArmor that keeps user namespaces from Chromium: named, unless a profile names that Chromium', () => {
  const exe = '/home/u/.cache/pdfkiln/chromium/158.0.8127.88/chrome-headless-shell-linux64/chrome-headless-shell';
  // Ubuntu 24.04, a shell of the user's.
  const files: Record<string, string> = {
    '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
    '/proc/self/attr/apparmor/current': 'unconfined\n',
  };
  const read = (p: string) => files[p] ?? null;
  assert.equal(appArmorRestricts(exe, read, () => ['profile firefox /usr/lib/firefox/firefox flags=(unconfined) {\n  userns,\n}\n']), exe);
  // A profile that names it, the Debian package's or the user's own.
  assert.equal(appArmorRestricts(exe, read, () => [`abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile pdfkiln-chromium ${exe} flags=(unconfined) {\n  userns,\n}\n`]), null);
  // Confined, as in a Docker container on Ubuntu: the container's profile
  // decides, which this process cannot read.
  files['/proc/self/attr/apparmor/current'] = 'docker-default (enforce)\n';
  assert.equal(appArmorRestricts(exe, read, () => []), null);
  // A kernel without the per-module file.
  delete files['/proc/self/attr/apparmor/current'];
  files['/proc/self/attr/current'] = 'unconfined\0';
  assert.equal(appArmorRestricts(exe, read, () => []), exe);
  // No restriction, or no AppArmor (Debian 13, WSL).
  files['/proc/sys/kernel/apparmor_restrict_unprivileged_userns'] = '0\n';
  assert.equal(appArmorRestricts(exe, read, () => []), null);
  assert.equal(appArmorRestricts(exe, () => null, () => []), null);
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  assert.equal(explain(closed, { appArmor: () => exe }, '--no-sandbox'), `Chromium's sandbox cannot start: AppArmor allows the user namespaces it needs only to programs with a profile that allows them, as on Ubuntu 23.10 and later. The Debian package loads one for its Chromium; for this one, load a profile that allows userns to ${exe} (https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). --no-sandbox works around it, not recommended.`);
  assert.equal(explain(closed, { appArmor: () => null, namespaces: () => true }), `Chromium did not start: ${closed}`);
  // Told before user namespaces, which AppArmor may refuse outright.
  assert.match(explain(closed, { appArmor: () => exe, namespaces: () => false }), /AppArmor/);
});

// The real start, by both commands: Chromium exits, and Puppeteer only says
// "Target closed" (Chromium 158). Each runs where its cause is: CI runs the
// first with sudo, the second before it loads its AppArmor profile.
test('as root, both commands say that Chromium refuses to run with its sandbox', { skip: !runsAsRoot() && 'as root, on Linux' }, () => {
  const wk = convert('wkhtmltopdf', ['-q']);
  assert.deepEqual(wk, { code: 1, pdf: false, stderr: 'Error: Chromium refuses to run as root with its sandbox on. Run the command as an unprivileged user (or pass --kiln-no-sandbox, not recommended).\nExit with code 1, due to unknown error.\n' });
  const native = convert('pdfkiln', []);
  assert.deepEqual(native, { code: 1, pdf: false, stderr: 'pdfkiln: error: Chromium refuses to run as root with its sandbox on. Run the command as an unprivileged user (or pass --no-sandbox, not recommended).\n' });
});

test('under AppArmor, both commands say that their Chromium needs a profile', (t) => {
  // A package's Chromium is its own, the Debian package's with its profile.
  const packaged = process.env.PDFKILN_TEST_WKHTMLTOPDF || process.env.PDFKILN_TEST_PDFKILN;
  const exe = packaged || runsAsRoot() ? null : appArmorRestricts(executablePath());
  if (!exe) return t.skip('where AppArmor keeps user namespaces from the Chromium of the sources');
  const why = `Chromium's sandbox cannot start: AppArmor allows the user namespaces it needs only to programs with a profile that allows them, as on Ubuntu 23.10 and later. The Debian package loads one for its Chromium; for this one, load a profile that allows userns to ${exe} (https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).`;
  assert.deepEqual(convert('wkhtmltopdf', ['-q']), { code: 1, pdf: false, stderr: `Error: ${why} --kiln-no-sandbox works around it, not recommended.\nExit with code 1, due to unknown error.\n` });
  assert.deepEqual(convert('pdfkiln', []), { code: 1, pdf: false, stderr: `pdfkiln: error: ${why} --no-sandbox works around it, not recommended.\n` });
});

// WSL and CI run it as an unprivileged user under systemd-run -p
// RestrictNamespaces=yes, a transient unit that refuses them as
// php-fpm's of packages.sury.org does.
test('in a systemd unit that refuses user namespaces, both commands name it', (t) => {
  const unit = runsAsRoot() || userNamespaces() !== false ? null : systemdUnit();
  const packaged = process.env.PDFKILN_TEST_WKHTMLTOPDF || process.env.PDFKILN_TEST_PDFKILN;
  if (!unit || (!packaged && appArmorRestricts(executablePath()))) return t.skip('in a systemd unit that refuses user namespaces');
  const ctl = unit.user ? 'systemctl --user' : 'systemctl';
  const why = `Chromium's sandbox cannot start: this system refuses the user namespaces it needs. PDFKiln runs in the systemd unit ${unit.name}, whose RestrictNamespaces= may refuse them: run ${ctl} edit ${unit.name}, add the lines [Service] and RestrictNamespaces=user pid net, the three namespaces the sandbox needs, then ${ctl} restart ${unit.name}. In a container, run it with PDFKiln's seccomp profile (docker run --security-opt seccomp=seccomp.json, from https://raw.githubusercontent.com/pdfkiln/pdfkiln/main/docker/seccomp.json); elsewhere, allow unprivileged user namespaces (user.max_user_namespaces, kernel.unprivileged_userns_clone).`;
  assert.deepEqual(convert('wkhtmltopdf', ['-q']), { code: 1, pdf: false, stderr: `Error: ${why} --kiln-no-sandbox works around it, not recommended.\nExit with code 1, due to unknown error.\n` });
  assert.deepEqual(convert('pdfkiln', []), { code: 1, pdf: false, stderr: `pdfkiln: error: ${why} --no-sandbox works around it, not recommended.\n` });
});

test('phases, padded over the progress bar', () => {
  let s = '';
  const fb = new Feedback('info', (x) => (s += x));
  fb.phaseChanged(0);
  fb.progressChanged(100, '100%');
  fb.phaseChanged(1);
  fb.phaseChanged(6);
  assert.equal(s.split('\r')[0], 'Loading pages (1/6)\n[' + '='.repeat(60) + '] 100%');
  assert.match(s, /\rCounting pages \(2\/6\) {47}\nDone\n$/);
});

test('log levels', () => {
  let s = '';
  const fb = new Feedback('warn', (x) => (s += x));
  fb.phaseChanged(0);
  fb.warning('w');
  fb.error('e');
  assert.equal(s, 'Warning: w\nError: e\n');
  s = '';
  const quiet = new Feedback('none', (x) => (s += x));
  quiet.error('e');
  assert.equal(s, '');
});
