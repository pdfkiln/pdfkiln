import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropUnknownCss, rewriteCss, rewriteMediaPrelude, rewriteMediaTypes } from '../src/engine/emulation.js';
import { isPrivateAddress } from '../src/engine/relay.js';
import { hfreplace, withParms } from '../src/wk/headers.js';
import { sectionCache } from '../src/wk/convert.js';
import { guessUrlFromString, looksLikeHtmlAndNotAUrl } from '../src/wk/urls.js';

test('media queries against a 0 x 0 viewport', () => {
  assert.equal(rewriteMediaPrelude('screen and (max-width: 600px)', 0, 0), 'screen and (min-width: 0px)');
  assert.equal(rewriteMediaPrelude('(min-width:768px)', 0, 0), '(min-width: 1000000px)');
  assert.equal(rewriteMediaPrelude('(min-width: 40em)', 1280, 0), '(min-width: 0px)');
  const once = rewriteCss('@media (max-width: 10px){a{b:c}}', { mediaViewport: [0, 0] });
  assert.equal(rewriteCss(once, { mediaViewport: [0, 0] }), once);
});

test('media types, as a screen sees them', () => {
  assert.equal(rewriteMediaTypes('screen'), 'all');
  assert.equal(rewriteMediaTypes('print'), 'all and (min-width: 1000000px)');
  assert.equal(rewriteMediaTypes('only screen and (min-width: 0px)'), 'only all and (min-width: 0px)');
  assert.equal(rewriteMediaTypes('not print'), 'not all and (min-width: 1000000px)');
  assert.equal(rewriteMediaTypes('screen, print'), 'all, all and (min-width: 1000000px)');
  assert.equal(rewriteCss('@media print{a{}}@media screen and (max-width:9px){b{}}', { mediaViewport: [0, 0], screenTypes: true }),
    '@media all and (min-width: 1000000px){a{}}@media all and (min-width: 0px){b{}}');
});

test('@page rules are dropped', () => {
  assert.equal(rewriteCss('a{}@page{margin:0;@top-center{content:"x"}}b{}', { dropPageRules: true }), 'a{}b{}');
  assert.equal(rewriteCss('@page :first { size: A5 } p{}', { dropPageRules: true }), ' p{}');
});

test('private addresses', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::', '::1', 'fe80::1', 'fd00::1', 'FE80::1%eth0']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  // IPv4 in IPv6, in the forms a URL or a resolver gives: judged as IPv4.
  for (const a of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:c0a8:101', '::7f00:1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:5db8:d822', '64:ff9b::5db8:d822', '2001:db8::7f00:1']) {
    assert.equal(isPrivateAddress(a), false, a);
  }
});

test('header variables', () => {
  assert.equal(hfreplace('[Page]/[topage] [x]', { page: '2', topage: '5' }), '2/5 [x]');
  assert.equal(withParms('file:///h.html', { section: 'A b', page: '1' }), 'file:///h.html?section=A%20b&page=1');
});

test('[section] is the first heading of the page, carried over', () => {
  const item = (title: string, page: number, children = []) => ({ title, page, dest: null, children });
  // One document: page 1 has A then B, page 3 has C.
  const roots = [[item('A', 0), item('B', 0), item('C', 2)]];
  const s = sectionCache(roots as never, [0, 4], 4);
  assert.deepEqual(s[0]!.slice(1, 5), ['A', 'A', 'C', 'C']);
});

test('page arguments to URLs', () => {
  assert.equal(guessUrlFromString('http://example.com/a'), 'http://example.com/a');
  assert.equal(guessUrlFromString('example.com/a'), 'http://example.com/a');
  assert.equal(guessUrlFromString('localhost:8080'), 'http://localhost:8080/');
  assert.match(guessUrlFromString('package.json'), /^file:\/\/.*package\.json$/);
  assert.equal(looksLikeHtmlAndNotAUrl('<b>x</b>'), true);
  assert.equal(looksLikeHtmlAndNotAUrl('header.html?a=<b>'), false);
});

test('CSS that WebKit 534 does not parse is dropped, its fallbacks stay', () => {
  assert.equal(dropUnknownCss('.row{display: -webkit-box; display: -webkit-flex; display: flex; flex-wrap: wrap}'), '.row{display: -webkit-box; flex-wrap: wrap}');
  assert.equal(dropUnknownCss('a{display:inline-grid !important}b{display:block}'), 'a{}b{display:block}');
  assert.equal(dropUnknownCss('.d-flex{display:flex!important}'), '.d-flex{}');
  assert.equal(dropUnknownCss('x{grid-display: flex; display: inline-block}'), 'x{grid-display: flex; display: inline-block}');
  assert.equal(dropUnknownCss('.row{--bs-gutter-x: 1.5rem; margin-top: calc(-1 * var(--bs-gutter-y)); color: red; width: var(--w)}'), '.row{--bs-gutter-x: 1.5rem; color: red; }');
  assert.equal(dropUnknownCss('h1{font-size: 2em; font-size: calc(1.375rem + 1.5vw)}'), 'h1{font-size: 2em; }');
});
