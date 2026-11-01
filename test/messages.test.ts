// What wkhtmltopdf writes on stderr and how it exits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressSpace, chromiumCommand, explain, parseLdd } from '../src/engine/browser.js';
import { Feedback } from '../src/wk/feedback.js';
import { handleError, qtErrorForHttpStatus, qtErrorString } from '../src/wk/qtnet.js';

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
  assert.equal(explain(closed, () => false), `Chromium did not start: ${closed}`);
  assert.match(explain(closed, () => true), /^Chromium does not run on Windows Server Core: .* Desktop Experience/);
  assert.match(explain('Running as root without --no-sandbox is not supported', () => false), /refuses to run as root/);
});

test('Chromium that lacks a system library: named, from ldd or the loader', () => {
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
  assert.match(explain(closed, () => false, () => parseLdd(ldd)), /^Chromium cannot start: the system lacks libasound\.so\.2\. The Debian package/);
  // pdfkiln serve reads Chromium's stderr: the loader's own message.
  const loader = 'chrome-headless-shell: error while loading shared libraries: libasound.so.2: cannot open shared object file: No such file or directory';
  assert.match(explain(loader, () => false), /the system lacks libasound\.so\.2\./);
  assert.match(explain(loader, () => false, () => ['libasound.so.2', 'libgbm.so.1']), /lacks libasound\.so\.2, libgbm\.so\.1\./);
  assert.equal(explain(closed, () => false, () => []), `Chromium did not start: ${closed}`);
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
  assert.equal(explain(closed, () => false, () => [], () => ({ soft: 2684354560, hard: Infinity })), `Chromium did not start: ${closed}`);
  assert.match(explain(closed, () => false, () => [], () => ({ soft: 2684354560, hard: 2684354560 })), /^Chromium cannot start under a cap on its address space \(ulimit -v, RLIMIT_AS\) of 2560 MiB: .* LimitAS=infinity/);
});

test('a system that refuses user namespaces: the sandbox, and the seccomp profile', () => {
  // Under Docker's default seccomp profile, Chromium only says this (Odoo's
  // official image, 01/11/2026).
  const closed = 'Protocol error (Target.setDiscoverTargets): Target closed';
  const refused = (namespaces: boolean | null) => explain(closed, () => false, () => [], () => null, () => namespaces);
  assert.match(refused(false), /^Chromium's sandbox cannot start: this system refuses the user namespaces it needs\. In a container, run it with PDFKiln's seccomp profile \(docker run --security-opt seccomp=seccomp\.json, from https:\/\/raw\.githubusercontent\.com\/pdfkiln\/pdfkiln\/main\/docker\/seccomp\.json\)/);
  assert.equal(refused(true), `Chromium did not start: ${closed}`);
  assert.equal(refused(null), `Chromium did not start: ${closed}`);
  // Namespaces allowed, the sandbox still refused: AppArmor, from Chromium's own words.
  assert.match(explain('No usable sandbox!', () => false, () => [], () => null, () => true), /AppArmor/);
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
