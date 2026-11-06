import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateFailures } from '../bench/gate.js';

const row = (id: string, wk: number, ours: number, matched: number, same: number) => ({
  id,
  pages: { wkhtmltopdf: wk, pdfkiln: ours },
  comparison: { same_page: { matched, same_page: same } },
});

test('the corpus gate passes with the same page counts and 99 % of the words on the same page', () => {
  // 99.25 % as a whole, though one entry is under 99 %.
  assert.deepEqual(gateFailures([row('a', 2, 2, 1000, 1), row('b', 1, 1, 1000, 0.985)]), []);
});

test('a page count that differs misses the gate', () => {
  assert.deepEqual(gateFailures([row('a', 2, 2, 1000, 1), row('b', 2, 3, 1000, 1)]), ['b: 3 pages, wkhtmltopdf 2']);
});

test('under 99 % of the words on the same page misses the gate', () => {
  assert.deepEqual(gateFailures([row('a', 2, 2, 1000, 0.99), row('b', 1, 1, 1000, 0.97)]), ['98.00 % of the matched words on the same page, under 99 %']);
});

test('an entry without both PDFs misses the gate', () => {
  assert.deepEqual(gateFailures([row('a', 1, 1, 100, 1), { id: 'b' }]), ['b: no PDF to compare']);
});
