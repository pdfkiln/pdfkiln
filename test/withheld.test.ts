// The status of a response Chromium keeps from the page, read whether it
// comes before or after the failure: without Chromium, so the order is the
// test's, not the machine's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hadResponse, isBlock, Withheld, type Block } from '../src/engine/withheld.js';

// As Chromium 157.0.8103.78 reports them. Blocked once the response came:
const orb: Block = { errorText: 'net::ERR_BLOCKED_BY_ORB' };
const corp: Block = { errorText: 'net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin', blockedReason: 'corp-not-same-origin' };
const cors: Block = { errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'MissingAllowOriginHeader' } };
// Blocked before it was sent, no status ever:
const csp: Block = { errorText: '', blockedReason: 'csp' };
const preflight: Block = { errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'PreflightMissingAllowOriginHeader' } };
const local: Block = { errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'LocalNetworkAccessPermissionDenied' } };

// A request in flight, then its failure, as the loader gives them: the
// statuses before it, then the block.
function fails(e: Block, before: number[] = []) {
  const inflight = new Set(['r']);
  const withheld = new Withheld(inflight);
  const read: number[] = [];
  for (const s of before) withheld.status('r', s);
  inflight.delete('r');
  withheld.failed('r', e, (s) => read.push(s));
  return { inflight, withheld, read };
}

test('a status after the failure: the request stays in flight until it is read', () => {
  for (const e of [orb, corp, cors]) {
    assert.ok(isBlock(e) && hadResponse(e));
    const { inflight, withheld, read } = fails(e);
    assert.deepEqual([...inflight], ['r'], e.errorText);
    assert.deepEqual(read, []);
    withheld.status('r', 404);
    assert.deepEqual(read, [404]);
    assert.equal(inflight.size, 0);
  }
});

test('a status before the failure: read at once', () => {
  const { inflight, read } = fails(orb, [404]);
  assert.deepEqual(read, [404]);
  assert.equal(inflight.size, 0);
});

test('blocked before it was sent: nothing holds the page', () => {
  for (const e of [csp, preflight, local]) {
    assert.ok(isBlock(e) && !hadResponse(e));
    const { inflight, withheld, read } = fails(e);
    assert.equal(inflight.size, 0, e.blockedReason ?? e.corsErrorStatus?.corsError ?? '');
    assert.deepEqual(read, []);
    // A status that comes all the same is read.
    withheld.status('r', 404);
    assert.deepEqual(read, [404]);
  }
});

test('after redirects, the final status is read', () => {
  // The redirect's before the failure, the final one after it.
  let f = fails(orb, [302]);
  assert.deepEqual([...f.inflight], ['r']);
  f.withheld.status('r', 404);
  assert.deepEqual(f.read, [404]);
  assert.equal(f.inflight.size, 0);
  // Both after it.
  f = fails(cors);
  f.withheld.status('r', 301);
  assert.deepEqual(f.read, []);
  assert.deepEqual([...f.inflight], ['r']);
  f.withheld.status('r', 200);
  assert.deepEqual(f.read, [200]);
  assert.equal(f.inflight.size, 0);
  // Both before it.
  assert.deepEqual(fails(orb, [302, 404]).read, [404]);
});

test('a failure that is no block', () => {
  for (const errorText of ['net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_ABORTED']) assert.ok(!isBlock({ errorText }));
});
