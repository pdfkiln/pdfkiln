// [time] and [date] of the headers, as wkhtmltopdf 0.12.6 writes them
// (Qt 4.8's SystemLocaleShortDate), measured on 17/11/2026: the official
// Linux build by LANG, the Windows build on a French system.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { qtDateTime } from '../src/wk/headers.js';

const now = new Date(2026, 10, 5, 16, 37, 6);

test('Linux without a locale: Qt\'s own formats, with the seconds', () => {
  for (const env of [{}, { LANG: 'C' }, { LANG: 'C.UTF-8' }, { LANG: 'POSIX' }, { LANG: 'fr_FR.UTF-8', LC_ALL: 'C' }]) {
    assert.deepEqual(qtDateTime(now, 'linux', env), { time: '16:37:06', date: '5 Nov 2026' }, JSON.stringify(env));
  }
});

test('Linux with a locale: its short formats, LC_ALL, then LC_TIME, then LANG', () => {
  assert.deepEqual(qtDateTime(now, 'linux', { LANG: 'de_DE.UTF-8' }), { time: '16:37', date: '05.11.26' });
  assert.deepEqual(qtDateTime(now, 'linux', { LANG: 'C', LC_TIME: 'en_GB.UTF-8' }), { time: '16:37', date: '05/11/2026' });
  const us = qtDateTime(now, 'linux', { LANG: 'en_US.UTF-8' });
  assert.match(us.time, /^4:37\sPM$/u);
  assert.equal(us.date, '11/5/26');
});

test('Windows: the time with its seconds', () => {
  assert.match(qtDateTime(now, 'win32', {}).time, /37.06/);
});
