// The compatible mode loads no address that wkhtmltopdf 0.12.6's WebKit 534
// never read. An application that cleans the HTML it gives wkhtmltopdf of
// what WebKit loads (url(), @import, src, href) leaves what WebKit did not
// read: Chromium would fetch it. So, before Chromium reads a page, its
// frames and its style sheets, these are taken out:
// - image-set() and -webkit-image-set(), whose address may be a string: the
//   declaration that holds one, as WebKit dropped it;
// - srcset and sizes of img and source, src of source, imagesrcset and
//   imagesizes of link, and the href of a link that is no style sheet
//   (preload, prefetch, modulepreload...);
// - poster and src of video, src of audio and track (no media in WebKit
//   534), srcdoc of iframe;
// - in SVG, href without xlink: (SVG 2) to another document, and fill,
//   stroke, marker-*, clip-path, mask and filter attributes that point into
//   another document;
// - a declaration that loads an address where WebKit 534 did not read it:
//   a property whose url() it did not load (mask-image, border-image...), a
//   value it did not parse (linear-gradient(), calc(), var(), a size after
//   / in background), a rule it did not apply (@supports, @layer, :is(),
//   nesting, a media query it found false); an @import with conditions it
//   did not parse. Only these declarations go: the others stay as Chromium
//   reads them. Of an @font-face, the woff2 source stays, which Chromium
//   takes where WebKit took the next: an address of the same src, and the
//   only one that servers such as Google Fonts give Chromium.
// Chromium reads data: documents (an iframe's, an object's) and data:
// style sheets without the Fetch domain: they are cleaned here, written
// again in UTF-8. A page is read in the encoding Chromium will read it in
// (serveFile pins it), else a Shift_JIS or ISO-2022-JP page could hide an
// image-set( from this reading. Scripts run after: what they add is
// theirs, and an application that cleans HTML runs it without JavaScript.
import { parse, type DefaultTreeAdapterTypes as P } from 'parse5';
import sax from 'sax';
import { lowerAscii, tokenize, type Token, type TokenType } from './css-tokens.js';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

interface Context {
  scripting: boolean; // JavaScript on: <noscript> is text
  depth: number; // of data: documents within data: documents
  // What a style element or attribute, or a data: style sheet, becomes:
  // cleanCss, or the compatible mode's rewriting, which holds it
  // (rewriteCss), as a style sheet served from the network is rewritten.
  css?: (text: string) => string;
}
const MAX_DEPTH = 8;

type Edit = [start: number, end: number, text: string];

function applyEdits(text: string, edits: Edit[]): string {
  if (!edits.length) return text;
  edits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = '';
  let at = 0;
  for (const [start, end, by] of edits) {
    if (start < at) {
      // Within an edit already made: a removal may reach further.
      if (by === '' && end > at) at = end;
      continue;
    }
    out += text.slice(at, start) + by;
    at = end;
  }
  return out + text.slice(at);
}

// --- CSS ---

const IMAGE_SETS = new Set(['image-set', '-webkit-image-set']);
const OPENS: Partial<Record<TokenType, TokenType>> = { '(': ')', function: ')', '[': ']', '{': '}' };
const CLOSES = new Set<TokenType>([')', ']', '}']);

// [start, end) of the declaration, statement or rule that holds the token
// at i: back to the ";", "{" or "}" before it at its level, on to the ";"
// after it (included) or the "}" that closes its block (left); the block
// too when it is in a rule's prelude.
function around(tokens: Token[], i: number, length: number): [number, number] {
  let start = 0;
  const back: TokenType[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j]!.type;
    if (!back.length && (t === ';' || t === '{' || t === '}')) {
      start = tokens[j]!.end;
      break;
    }
    if (CLOSES.has(t)) back.push(t);
    // An opener left open holds the token: the declaration goes on.
    else if (OPENS[t] && back[back.length - 1] === OPENS[t]) back.pop();
  }
  const open = OPENS[tokens[i]!.type];
  const stack: TokenType[] = open ? [open] : [];
  for (let k = i + 1; k < tokens.length; k++) {
    const t = tokens[k]!.type;
    const closer = OPENS[t];
    if (closer) {
      if (t === '{' && !stack.length) {
        // A prelude: the rule with its block.
        let braces = 0;
        for (let m = k; m < tokens.length; m++) {
          if (tokens[m]!.type === '{') braces++;
          else if (tokens[m]!.type === '}' && --braces === 0) return [start, tokens[m]!.end];
        }
        return [start, length];
      }
      stack.push(closer);
    } else if (CLOSES.has(t)) {
      if (stack.length && stack[stack.length - 1] === t) stack.pop();
      else if (!stack.length && t === '}') return [start, tokens[k]!.start];
    } else if (t === ';' && !stack.length) return [start, tokens[k]!.end];
  }
  return [start, length];
}

const cssString = (s: string) => `"${s.replace(/[\\"\n\r\f]/g, (c) => (c === '\n' ? '\\a ' : c === '\r' ? '\\d ' : c === '\f' ? '\\c ' : `\\${c}`))}"`;

// The URL of a url token or of url("..."), with the index of its last token.
function urlAt(tokens: Token[], i: number): [string, number] | undefined {
  const t = tokens[i]!;
  if (t.type === 'url' || t.type === 'bad-url') return [t.value, i];
  if (t.type !== 'function' || lowerAscii(t.value) !== 'url') return undefined;
  let k = i + 1;
  while (tokens[k]?.type === 'whitespace') k++;
  if (tokens[k]?.type !== 'string') return undefined;
  let m = k + 1;
  while (tokens[m]?.type === 'whitespace') m++;
  return [tokens[k]!.value, tokens[m]?.type === ')' ? m : k];
}

// What WebKit 534 read of a declaration that loads an address, measured on
// wkhtmltopdf 0.12.6 against a loopback server: it loaded the url() of
// these properties, with these functions, in these rules, and no other.
const URL_PROPERTIES = new Set([
  'background', 'background-image', 'list-style', 'list-style-image', 'content', 'cursor',
  '-webkit-border-image', '-webkit-mask', '-webkit-mask-image', '-webkit-mask-box-image', '-webkit-box-reflect',
]);
// Another function made the declaration invalid there: linear-gradient(),
// calc(), min(), var(), -webkit-cross-fade(), tech()...
const FUNCTIONS = new Set([
  'url', 'rgb', 'rgba', 'hsl', 'hsla', 'attr', 'counter', 'counters', 'rect', 'local', 'format', '-webkit-canvas',
  '-webkit-gradient', '-webkit-linear-gradient', '-webkit-radial-gradient', '-webkit-repeating-linear-gradient', '-webkit-repeating-radial-gradient',
]);
// At-rules: it did not apply what @supports, @layer, @container, @page or
// an unprefixed @keyframes hold.
const AT_RULES = new Set(['media', 'font-face', '-webkit-keyframes']);
// Media features: a query with another (prefers-color-scheme), or in a
// syntax it did not know (width >= 0, or), was false there.
const MEDIA_FEATURES = new Set([
  ...['width', 'height', 'device-width', 'device-height', 'aspect-ratio', 'device-aspect-ratio', 'color', 'color-index', 'monochrome'].flatMap((f) => [f, `min-${f}`, `max-${f}`]),
  'orientation', 'grid', 'scan', '-webkit-device-pixel-ratio', '-webkit-min-device-pixel-ratio', '-webkit-max-device-pixel-ratio',
  '-webkit-transform-2d', '-webkit-transform-3d', '-webkit-transition', '-webkit-animation', '-webkit-view-mode',
]);
// Selectors: a rule with another was dropped (:is(), :where(), :has(),
// :focus-within, a flag in [a=b i], :not() of more than a simple
// selector, :nth-child(… of S), nesting).
const PSEUDO_CLASSES = new Set([
  'active', 'checked', 'default', 'disabled', 'empty', 'enabled', 'first-child', 'first-of-type', 'focus', 'hover',
  'indeterminate', 'invalid', 'last-child', 'last-of-type', 'link', 'only-child', 'only-of-type', 'optional',
  'read-only', 'read-write', 'required', 'root', 'target', 'valid', 'visited', 'before', 'after', 'first-line',
  'first-letter', 'window-inactive', 'horizontal', 'vertical', 'decrement', 'increment', 'start', 'end',
  'double-button', 'single-button', 'no-button', 'corner-present',
]);
const PSEUDO_FUNCTIONS = new Set(['not', 'nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type', 'lang', '-webkit-any']);
const PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter', 'selection']);
const POSITIONS = new Set(['left', 'right', 'top', 'bottom', 'center']);
const nonBlank = (t: Token[]) => t.filter((x) => x.type !== 'whitespace');

function selectorOk(t: Token[]): boolean {
  for (let i = 0; i < t.length; i++) {
    const k = t[i]!;
    if (k.type === 'whitespace' || k.type === 'ident' || k.type === 'hash' || k.type === ',') continue;
    if (k.type === 'delim') {
      if ('.*>+~|'.includes(k.value)) continue;
      return false;
    }
    if (k.type === '[') {
      const close = t.findIndex((x, j) => j > i && x.type === ']');
      if (close === -1) return false;
      const inner = nonBlank(t.slice(i + 1, close));
      const eq = inner.findIndex((x) => x.type === 'delim' && x.value === '=');
      // [a], [ns|a], [a=v], [a~=v]...: one value, no flag after it.
      if ((eq !== -1 && inner.length - eq !== 2) || inner.some((x) => x.type !== 'ident' && x.type !== 'string' && x.type !== 'delim')) return false;
      i = close;
      continue;
    }
    if (k.type !== ':') return false;
    const n = t[i + 1];
    if (n?.type === ':') {
      const e = t[i + 2];
      if (e?.type !== 'ident' || !(PSEUDO_ELEMENTS.has(lowerAscii(e.value)) || lowerAscii(e.value).startsWith('-webkit-'))) return false;
      i += 2;
    } else if (n?.type === 'ident') {
      if (!(PSEUDO_CLASSES.has(lowerAscii(n.value)) || lowerAscii(n.value).startsWith('-webkit-'))) return false;
      i += 1;
    } else if (n?.type === 'function' && PSEUDO_FUNCTIONS.has(lowerAscii(n.value))) {
      const name = lowerAscii(n.value);
      let depth = 1;
      let j = i + 2;
      for (; j < t.length && depth > 0; j++) {
        if (t[j]!.type === '(' || t[j]!.type === 'function') depth++;
        else if (t[j]!.type === ')') depth--;
      }
      const args = t.slice(i + 2, j - 1);
      const a = nonBlank(args);
      if (name.startsWith('nth-') && a.some((x) => x.type === 'ident' && lowerAscii(x.value) === 'of')) return false;
      if (name === 'not') {
        const simple = (a.length === 1 && (a[0]!.type === 'ident' || a[0]!.type === 'hash' || (a[0]!.type === 'delim' && a[0]!.value === '*')))
          || (a.length === 2 && a[0]!.type === 'delim' && a[0]!.value === '.' && a[1]!.type === 'ident')
          || (a.length === 2 && a[0]!.type === ':' && a[1]!.type === 'ident' && PSEUDO_CLASSES.has(lowerAscii(a[1]!.value)))
          || (a[0]?.type === '[' && a[a.length - 1]?.type === ']' && !a.slice(1, -1).some((x) => x.type === '[' || x.type === ']'));
        if (!simple) return false;
      }
      if (name === '-webkit-any' && !selectorOk(args)) return false;
      i = j - 1;
    } else return false;
  }
  return true;
}

// features: whether a feature it did not know makes the query false, as
// in @media; an @import loaded its sheet whatever its media.
function mediaOk(t: Token[], features: boolean): boolean {
  const q = nonBlank(t);
  for (let i = 0; i < q.length; i++) {
    const k = q[i]!;
    if (k.type === ',') continue;
    if (k.type === 'ident') {
      if (lowerAscii(k.value) === 'or' || lowerAscii(k.value) === 'layer') return false;
      continue;
    }
    if (k.type !== '(') return false;
    const close = q.findIndex((x, j) => j > i && x.type === ')');
    if (close === -1) return false;
    const inner = q.slice(i + 1, close);
    if (inner[0]?.type !== 'ident' || (features && !MEDIA_FEATURES.has(lowerAscii(inner[0].value)))) return false;
    if (inner.length > 1 && (inner[1]!.type !== ':' || inner.length === 2 || inner.slice(2).some((x) => !['number', 'dimension', 'percentage', 'ident'].includes(x.type) && !(x.type === 'delim' && x.value === '/')))) return false;
    i = close;
  }
  return true;
}

// background: no size after /, positions of two values at most.
function backgroundOk(t: Token[]): boolean {
  let depth = 0;
  let positions = 0;
  for (const k of t) {
    if (k.type === 'function' || k.type === '(') depth++;
    else if (k.type === ')') depth--;
    else if (depth > 0) continue;
    else if (k.type === 'delim' && k.value === '/') return false;
    else if (k.type === ',') positions = 0;
    else if ((k.type === 'ident' && POSITIONS.has(lowerAscii(k.value))) || k.type === 'dimension' || k.type === 'percentage' || k.type === 'number') {
      if (++positions > 2) return false;
    }
  }
  return true;
}

interface Block {
  at?: string; // the at-rule's name; none for a style rule
  bad: boolean; // a block WebKit 534 did not apply
}

// A style sheet or the declarations of a style attribute, without the
// declarations that hold image-set(), without those that load an address
// WebKit 534 did not read, and with its data: imports cleaned.
export function cleanCss(css: string, ctx: Context = { scripting: true, depth: 0 }): string {
  // Escaped, a name has a backslash.
  if (!/image-set|url|data:|\\/i.test(css)) return css;
  const tokens = tokenize(css);
  const edits: Edit[] = [];
  tokens.forEach((t, i) => {
    if (t.type === 'function' && IMAGE_SETS.has(lowerAscii(t.value))) {
      const [start, end] = around(tokens, i, css.length);
      edits.push([start, end, '']);
    }
  });
  // @import: of a data: sheet, cleaned; with conditions WebKit 534 did not
  // parse (layer(), supports(), media queries of Level 4), dropped.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.type !== 'at-keyword' || lowerAscii(t.value) !== 'import') continue;
    let j = i + 1;
    while (tokens[j]?.type === 'whitespace') j++;
    if (!tokens[j]) break;
    const found = tokens[j]!.type === 'string' ? ([tokens[j]!.value, j] as [string, number]) : urlAt(tokens, j);
    if (!found) continue;
    let end = found[1] + 1;
    while (end < tokens.length && tokens[end]!.type !== ';') end++;
    if (fetches(found[0]) && !mediaOk(tokens.slice(found[1] + 1, end), false)) {
      edits.push([...around(tokens, i, css.length), '']);
      continue;
    }
    if (!isData(found[0])) continue;
    const cleaned = cleanDataUrl(found[0], 'css', ctx);
    if (cleaned === null) edits.push([...around(tokens, i, css.length), '']);
    else if (cleaned !== found[0]) edits.push([tokens[j]!.start, tokens[found[1]]!.end, `url(${cssString(cleaned)})`]);
  }
  // Each declaration that loads an address, read as WebKit 534 read it.
  const stack: Block[] = [];
  const judged = new Set<number>();
  let from = 0;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const u = urlAt(tokens, i);
    if (u && fetches(u[0])) {
      const [start, end] = around(tokens, i, css.length);
      let a = i;
      while (a > 0 && tokens[a - 1]!.start >= start) a--;
      let b = i;
      while (b < tokens.length && tokens[b]!.end <= end) b++;
      const decl = nonBlank(tokens.slice(a, b));
      if (!judged.has(start) && decl[0]?.type === 'ident' && decl[1]?.type === ':') {
        judged.add(start);
        const prop = lowerAscii(decl[0].value);
        const value = decl.slice(2).filter((k) => k.type !== ';');
        const block = stack[stack.length - 1];
        const drop = Boolean(block?.bad) || prop.startsWith('--')
          || (block?.at === 'font-face' ? prop !== 'src' : !URL_PROPERTIES.has(prop))
          || value.some((k) => k.type === 'function' && !FUNCTIONS.has(lowerAscii(k.value)) && !IMAGE_SETS.has(lowerAscii(k.value)))
          || (prop === 'background' && !backgroundOk(value));
        if (drop) edits.push([start, end, '']);
      }
    }
    if (t.type === '(' || t.type === 'function' || t.type === '[') depth++;
    else if ((t.type === ')' || t.type === ']') && depth > 0) depth--;
    else if (depth === 0 && t.type === '{') {
      const prelude = tokens.slice(from, i);
      const head = nonBlank(prelude)[0];
      const parent = stack[stack.length - 1];
      if (head?.type === 'at-keyword') {
        const name = lowerAscii(head.value);
        const rest = prelude.slice(prelude.indexOf(head) + 1);
        stack.push({ at: name, bad: Boolean(parent?.bad) || (parent !== undefined && parent.at !== 'media') || !AT_RULES.has(name) || (name === 'media' && !mediaOk(rest, true)) });
      } else {
        // A style rule: at the top or in @media; keyframes take theirs.
        const keyframe = parent?.at === '-webkit-keyframes';
        stack.push({ bad: Boolean(parent?.bad) || (parent !== undefined && parent.at !== 'media' && !keyframe) || (!keyframe && !selectorOk(prelude)) });
      }
      from = i + 1;
    } else if (depth === 0 && t.type === '}') {
      stack.pop();
      from = i + 1;
    } else if (depth === 0 && t.type === ';') from = i + 1;
  }
  return applyEdits(css, edits);
}

const isData = (url: string) => /^[\t\n\f\r ]*data:/i.test(url);
// An address Chromium fetches: not within the document, not data:.
const fetches = (url: string) => {
  const u = url.trim();
  return !u.startsWith('#') && !isData(u);
};

// A value with url() to another document (fill="url(other.svg#g)").
function pointsElsewhere(value: string): boolean {
  if (!/url|\\/i.test(value)) return false;
  const tokens = tokenize(value);
  return tokens.some((_, i) => {
    const u = urlAt(tokens, i);
    return u !== undefined && fetches(u[0]);
  });
}

// --- Encodings ---

function bomEncoding(b: Buffer): string | undefined {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  if (b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  return undefined;
}

// The Encoding Standard's name for a label; undefined for an unknown one.
function encodingOf(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return undefined;
  }
}

const decode = (b: Buffer, encoding: string) => new TextDecoder(encoding).decode(b);

function isUtf8(b: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

// Bytes that do not read the same in every encoding: high ones, and the
// escape of ISO-2022-JP.
const notAscii = (b: Buffer) => b.some((x) => x >= 0x80 || x === 0x1b);

const attr = (el: P.Element, name: string) => el.attrs.find((a) => a.name === name && !a.namespace)?.value;
const isElement = (n: P.ChildNode): n is P.Element => 'tagName' in n;

// The charset a meta element of the head declares, as Chromium reads it
// (UTF-16 there is UTF-8). Read on the bytes as Latin-1: the markup is
// ASCII in every encoding a meta may declare.
function metaEncoding(b: Buffer): string | undefined {
  // Its first 64 KiB, where a head declares it: what it declares does not
  // change what this reads, since the charset is then pinned, only how well
  // a page that declares one is read.
  const doc = parse(b.subarray(0, 65536).toString('latin1'));
  const html = doc.childNodes.find((n): n is P.Element => isElement(n) && n.tagName === 'html');
  const head = html?.childNodes.find((n): n is P.Element => isElement(n) && n.tagName === 'head');
  for (const el of head?.childNodes ?? []) {
    if (!isElement(el) || el.tagName !== 'meta') continue;
    let name = attr(el, 'charset');
    if (name === undefined && lowerAscii(attr(el, 'http-equiv') ?? '').trim() === 'content-type') {
      name = /charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r ;"']+))/i.exec(attr(el, 'content') ?? '')?.slice(1).find((s) => s !== undefined);
    }
    const e = encodingOf(name);
    if (e) return e.startsWith('utf-16') ? 'utf-8' : e === 'x-user-defined' ? 'windows-1252' : e;
  }
  return undefined;
}

// The encoding of an HTML document: its BOM, the charset it is served
// with, its meta element, else UTF-8 for bytes that are UTF-8, and
// windows-1252, as wkhtmltopdf's WebKit reads a page that declares none.
export function htmlEncoding(b: Buffer, declared?: string): string {
  return bomEncoding(b) ?? encodingOf(declared) ?? metaEncoding(b) ?? (notAscii(b) && isUtf8(b) ? 'utf-8' : 'windows-1252');
}

function xmlEncoding(b: Buffer, declared?: string): string {
  const decl = /^(?:\xef\xbb\xbf)?<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/.exec(b.subarray(0, 256).toString('latin1'))?.[1];
  return bomEncoding(b) ?? encodingOf(declared) ?? encodingOf(decl) ?? 'utf-8';
}

function cssEncoding(b: Buffer, declared?: string): string {
  const rule = /^@charset "([^"]+)";/.exec(b.subarray(0, 128).toString('latin1'))?.[1];
  return bomEncoding(b) ?? encodingOf(declared) ?? encodingOf(rule) ?? (isUtf8(b) ? 'utf-8' : 'windows-1252');
}

// Text written again in its own encoding when that is UTF-8 or takes one
// byte a character, else in UTF-8.
const singleByteTables = new Map<string, Map<number, number> | null>();
function encode(text: string, encoding: string): { body: Buffer; encoding: string } {
  if (encoding === 'utf-8') return { body: Buffer.from(text, 'utf8'), encoding };
  if (!singleByteTables.has(encoding)) {
    const chars = decode(Buffer.from(Array.from({ length: 256 }, (_, i) => i)), encoding);
    let table: Map<number, number> | null = null;
    if (chars.length === 256) {
      table = new Map();
      for (let i = 0; i < 256; i++) if (chars.charCodeAt(i) !== 0xfffd && !table.has(chars.charCodeAt(i))) table.set(chars.charCodeAt(i), i);
    }
    singleByteTables.set(encoding, table);
  }
  const table = singleByteTables.get(encoding);
  if (table) {
    const out = Buffer.alloc(text.length);
    let ok = true;
    for (let i = 0; i < text.length && ok; i++) {
      const b = table.get(text.charCodeAt(i));
      if (b === undefined) ok = false;
      else out[i] = b;
    }
    if (ok) return { body: out, encoding };
  }
  return { body: Buffer.from(text, 'utf8'), encoding: 'utf-8' };
}

// --- data: URLs ---

function percentDecode(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const cp = s.codePointAt(i)!;
      const bytes = Buffer.from(String.fromCodePoint(cp), 'utf8');
      out.push(...bytes);
      if (cp > 0xffff) i++;
    }
  }
  return Buffer.from(out);
}

const isXmlType = (mime: string) => mime === 'image/svg+xml' || mime === 'application/xhtml+xml' || mime === 'text/xml' || mime === 'application/xml' || mime.endsWith('+xml');

// A data: style sheet (css) or document (an HTML or XML one; another, an
// image, stays), cleaned, or null when it cannot be: too deep, or XML this
// cannot read. Written again in UTF-8 when it changes or when its bytes
// could read otherwise.
export function cleanDataUrl(url: string, kind: 'css' | 'document', ctx: Context): string | null {
  const m = /^[\t\n\f\r ]*data:([^,]*),([\s\S]*)$/i.exec(url);
  if (!m) return url;
  const params = m[1]!.split(';').map((p) => p.trim());
  const mime = lowerAscii(params[0] || 'text/plain');
  const base64 = params.slice(1).some((p) => lowerAscii(p) === 'base64');
  const charset = params.slice(1).map((p) => /^charset=(.*)$/i.exec(p)?.[1]?.replace(/^"|"$/g, '')).find((c) => c !== undefined);
  const html = kind === 'document' && mime === 'text/html';
  if (kind === 'document' && !html && !isXmlType(mime)) return url;
  if (ctx.depth >= MAX_DEPTH) return null;
  const bytes = base64 ? Buffer.from(m[2]!.replace(/[\t\n\f\r ]/g, ''), 'base64') : percentDecode(m[2]!);
  const encoding = kind === 'css' ? cssEncoding(bytes, charset) : html ? htmlEncoding(bytes, charset) : xmlEncoding(bytes, charset);
  const text = decode(bytes, encoding);
  const inner = { ...ctx, depth: ctx.depth + 1 };
  const cleaned = kind === 'css' ? (ctx.css ? ctx.css(text) : cleanCss(text, inner)) : html ? cleanHtml(text, inner) : cleanXml(text, inner);
  if (cleaned === null) return null;
  if (cleaned === text && !notAscii(bytes)) return url;
  return `data:${mime};charset=utf-8;base64,${Buffer.from(cleaned, 'utf8').toString('base64')}`;
}

// --- HTML ---

interface Attr {
  name: string;
  value: string;
  namespace?: string;
  prefix?: string;
  qname?: string; // XML: the name as written
}

const SVG_REFERENCES = new Set(['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end', 'clip-path', 'mask', 'filter']);

// The attributes without what WebKit 534 never loaded, or null when none
// changes.
function cleanAttributes(ns: string, tag: string, attrs: Attr[], ctx: Context): Attr[] | null {
  let changed = false;
  const get = (name: string) => attrs.find((a) => a.name === name && !a.namespace);
  const set = (a: Attr, value: string | null) => {
    if (value === null) attrs.splice(attrs.indexOf(a), 1);
    else if (value === a.value) return;
    else a.value = value;
    changed = true;
  };
  const drop = (...names: string[]) => {
    for (const name of names) {
      const a = get(name);
      if (a) set(a, null);
    }
  };
  const nested = (name: string) => {
    const a = get(name);
    if (a && isData(a.value)) set(a, cleanDataUrl(a.value, 'document', ctx));
  };
  if (ns === HTML_NS) {
    switch (tag) {
      case 'img':
        drop('srcset', 'sizes');
        break;
      case 'source':
        drop('srcset', 'sizes', 'src');
        break;
      case 'link': {
        drop('imagesrcset', 'imagesizes');
        const href = get('href');
        if (!lowerAscii(get('rel')?.value ?? '').split(/[\t\n\f\r ]+/).includes('stylesheet')) drop('href');
        else if (href && isData(href.value)) set(href, cleanDataUrl(href.value, 'css', ctx));
        break;
      }
      case 'video':
        drop('poster', 'src');
        break;
      case 'audio':
      case 'track':
        drop('src');
        break;
      case 'iframe':
        drop('srcdoc');
        nested('src');
        break;
      case 'frame':
      case 'embed':
        nested('src');
        break;
      case 'object':
        nested('data');
        break;
      case 'meta': {
        // A refresh to a data: document.
        const content = get('content');
        if (!content || lowerAscii(get('http-equiv')?.value ?? '').trim() !== 'refresh') break;
        const at = content.value.search(/data:/i);
        if (at === -1) break;
        const quote = /["']$/.exec(content.value.slice(0, at).trimEnd())?.[0] ?? '';
        let target = content.value.slice(at);
        if (quote && target.trimEnd().endsWith(quote)) target = target.trimEnd().slice(0, -1);
        const cleaned = cleanDataUrl(target, 'document', ctx);
        set(content, cleaned === null ? null : cleaned === target ? content.value : `${content.value.slice(0, at)}${cleaned}${quote}`);
        break;
      }
    }
  } else if (ns === SVG_NS) {
    for (const a of [...attrs]) {
      if (a.namespace) continue;
      if (a.name === 'href' && tag !== 'a' && fetches(a.value)) set(a, null);
      else if (SVG_REFERENCES.has(a.name) && pointsElsewhere(a.value)) set(a, null);
    }
  }
  const style = get('style');
  if (style) set(style, ctx.css ? ctx.css(style.value) : cleanCss(style.value, ctx));
  return changed ? attrs : null;
}

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function startTag(name: string, attrs: Attr[], selfClosing: boolean): string {
  const list = attrs.map((a) => ` ${a.qname ?? (a.prefix ? `${a.prefix}:${a.name}` : a.name)}="${escapeAttr(a.value)}"`).join('');
  return `<${name}${list}${selfClosing ? ' /' : ''}>`;
}

// An HTML document without what WebKit 534 never loaded: each start tag
// that changes written again from the attributes as parsed (the first of
// two of a name, as Chromium keeps), style elements cleaned, templates too.
export function cleanHtml(html: string, ctx: Context): string {
  const doc = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: ctx.scripting });
  const edits: Edit[] = [];
  const element = (el: P.Element) => {
    const loc = el.sourceCodeLocation;
    if (!loc?.startTag) return;
    const attrs = cleanAttributes(el.namespaceURI, el.tagName, el.attrs.map((a) => ({ ...a })), ctx);
    if (attrs) {
      const source = html.slice(loc.startTag.startOffset, loc.startTag.endOffset);
      edits.push([loc.startTag.startOffset, loc.startTag.endOffset, startTag(el.tagName, attrs, el.namespaceURI !== HTML_NS && /\/[\t\n\f\r ]*>$/.test(source))]);
    }
    if (el.tagName === 'style' && (el.namespaceURI === HTML_NS || el.namespaceURI === SVG_NS)) {
      const css = el.childNodes.map((c) => (c.nodeName === '#text' ? (c as P.TextNode).value : '')).join('');
      const cleaned = ctx.css ? ctx.css(css) : cleanCss(css, ctx);
      if (cleaned !== css) {
        // In HTML, raw text that must not end the element; in SVG, text.
        const text = el.namespaceURI === SVG_NS ? escapeText(cleaned) : /<\/style[\t\n\f\r />]/i.test(cleaned) ? '' : cleaned;
        edits.push([loc.startTag.endOffset, loc.endTag?.startOffset ?? loc.endOffset, text]);
      }
    }
  };
  const visit = (node: P.ParentNode) => {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      element(child);
      visit(child);
      if (child.tagName === 'template' && child.namespaceURI === HTML_NS) visit((child as P.Template).content);
    }
  };
  visit(doc);
  return applyEdits(html, edits);
}

// --- XML (SVG and XHTML documents) ---

// An XML document cleaned as HTML is, written again from its parse; null
// when it cannot be read here: not well-formed, or with a DTD of its own,
// whose entities only the browser would expand.
export function cleanXml(xml: string, ctx: Context): string | null {
  const parser = sax.parser(true, { xmlns: true });
  // XHTML's named characters, which Chromium knows from the doctype.
  (parser as unknown as { ENTITIES: Record<string, string> }).ENTITIES = { ...(sax as unknown as { ENTITIES: Record<string, string> }).ENTITIES };
  const out: string[] = [];
  const open: { selfClosing: boolean; style: boolean }[] = [];
  let style: string | null = null;
  let changed = false;
  parser.onerror = (e) => {
    throw e;
  };
  parser.ondoctype = (d) => {
    if (d.includes('[')) throw new Error('a DTD of its own');
    out.push(`<!DOCTYPE${d}>`);
  };
  parser.onprocessinginstruction = ({ name, body }) => {
    if (name === 'xml') out.push(`<?xml ${body.replace(/encoding\s*=\s*(["'])[^"']*\1/i, 'encoding="UTF-8"')}?>`);
    else out.push(`<?${name}${body ? ` ${body}` : ''}?>`);
  };
  parser.oncomment = (c) => out.push(`<!--${c}-->`);
  parser.onopentag = (t) => {
    const tag = t as sax.QualifiedTag;
    const attrs: Attr[] = Object.values(tag.attributes).map((a) => ({ name: a.local || a.name, value: a.value, namespace: a.uri || undefined, qname: a.name }));
    const kept = cleanAttributes(tag.uri, tag.local, attrs, ctx);
    if (kept) changed = true;
    out.push(startTag(tag.name, kept ?? attrs, false).replace(/>$/, tag.isSelfClosing ? '/>' : '>'));
    const isStyle = tag.local === 'style' && (tag.uri === SVG_NS || tag.uri === HTML_NS);
    open.push({ selfClosing: tag.isSelfClosing, style: isStyle });
    if (isStyle && !tag.isSelfClosing) style = '';
  };
  const text = (t: string) => {
    if (style !== null) style += t;
    else out.push(escapeText(t));
  };
  parser.ontext = text;
  parser.oncdata = text;
  parser.onclosetag = (name) => {
    const top = open.pop();
    if (top?.style && style !== null) {
      const cleaned = ctx.css ? ctx.css(style) : cleanCss(style, ctx);
      if (cleaned !== style) changed = true;
      out.push(escapeText(cleaned));
      style = null;
    }
    if (!top?.selfClosing) out.push(`</${name}>`);
  };
  try {
    parser.write(xml).close();
  } catch {
    return null;
  }
  return changed ? out.join('') : xml;
}

// --- Documents ---

export interface CleanedDocument {
  body: Buffer;
  // With the charset Chromium is to read it in.
  contentType: string;
  changed: boolean;
}

// A document served as contentType, cleaned; undefined for one that is not
// HTML nor XML. Read in the encoding the content type pins, which serveFile
// gives Chromium even when nothing changes; written again in that encoding
// when it takes one byte a character, else in UTF-8.
export function cleanDocument(body: Buffer, contentType: string, scripting: boolean, css?: (text: string) => string): CleanedDocument | undefined {
  const [type, ...params] = contentType.split(';');
  const mime = lowerAscii(type!.trim());
  const declared = params.map((p) => /^\s*charset\s*=\s*"?([^";]*)"?/i.exec(p)?.[1]).find((c) => c !== undefined);
  const ctx = { scripting, depth: 0, css };
  if (mime === 'text/html') {
    const encoding = htmlEncoding(body, declared);
    const text = decode(body, encoding);
    let cleaned = cleanHtml(text, ctx);
    if (cleaned === text) return { body, contentType: `${mime}; charset=${encoding}`, changed: false };
    let e = encode(cleaned, encoding);
    if (e.encoding !== encoding && css) {
      // Written again in UTF-8, a page in Shift_JIS or UTF-16 would lose
      // its encoding, which its style sheets and scripts may need: only
      // what must go, its styles rewritten in the page before printing.
      cleaned = cleanHtml(text, { ...ctx, css: undefined });
      if (cleaned === text) return { body, contentType: `${mime}; charset=${encoding}`, changed: false };
      e = encode(cleaned, encoding);
    }
    return { body: e.body, contentType: `${mime}; charset=${e.encoding}`, changed: true };
  }
  if (isXmlType(mime)) {
    const encoding = xmlEncoding(body, declared);
    const text = decode(body, encoding);
    const cleaned = cleanXml(text, ctx);
    if (cleaned === null || cleaned === text) return { body, contentType: `${mime}; charset=${encoding}`, changed: false };
    return { body: Buffer.from(cleaned, 'utf8'), contentType: `${mime}; charset=utf-8`, changed: true };
  }
  return undefined;
}
