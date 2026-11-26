// CSS Syntax Level 3's tokenizer (https://www.w3.org/TR/css-syntax-3/#tokenization),
// which Chromium follows: what a rewrite of CSS must see to know what
// Chromium will read, escapes resolved (\69mage-set( is image-set() and
// comments skipped. Each token keeps its place in the text.

export type TokenType =
  | 'ident' | 'function' | 'at-keyword' | 'hash' | 'string' | 'bad-string' | 'url' | 'bad-url'
  | 'delim' | 'number' | 'percentage' | 'dimension' | 'whitespace' | 'CDO' | 'CDC'
  | ':' | ';' | ',' | '[' | ']' | '(' | ')' | '{' | '}';

export interface Token {
  type: TokenType;
  start: number;
  end: number;
  // The name of an ident, function, at-keyword or hash, the value of a
  // string or url, the character of a delim; escapes resolved.
  value: string;
}

const isNewline = (c: number) => c === 0x0a || c === 0x0d || c === 0x0c;
const isWhitespace = (c: number) => isNewline(c) || c === 0x09 || c === 0x20;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
// NUL is read as U+FFFD, a name code point.
const isNameStart = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c >= 0x80 || c === 0;
const isName = (c: number) => isNameStart(c) || isDigit(c) || c === 0x2d;
const isNonPrintable = (c: number) => (c >= 1 && c <= 8) || c === 0x0b || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
const SINGLE = new Set([0x28, 0x29, 0x2c, 0x3a, 0x3b, 0x5b, 0x5d, 0x7b, 0x7d]);

// ASCII case-insensitive, as CSS compares names: no Unicode case folding.
export const lowerAscii = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

export function tokenize(css: string): Token[] {
  const n = css.length;
  const at = (k: number) => (k < n ? css.charCodeAt(k) : -1);
  const validEscape = (k: number) => at(k) === 0x5c && !isNewline(at(k + 1));

  // After a backslash: the code point it stands for, and where it ends.
  const escape = (k: number): [string, number] => {
    const c = at(k);
    if (c === -1) return ['�', k];
    if (isHex(c)) {
      let j = k;
      while (j < n && j - k < 6 && isHex(at(j))) j++;
      const cp = parseInt(css.slice(k, j), 16);
      if (at(j) === 0x0d && at(j + 1) === 0x0a) j += 2;
      else if (isWhitespace(at(j))) j++;
      return [cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff ? '�' : String.fromCodePoint(cp), j];
    }
    const s = String.fromCodePoint(css.codePointAt(k)!);
    return [c === 0 ? '�' : s, k + s.length];
  };

  const startsIdent = (k: number) => {
    const c = at(k);
    if (c === 0x2d) {
      const d = at(k + 1);
      return d !== -1 && (isNameStart(d) || d === 0x2d || validEscape(k + 1));
    }
    if (c !== -1 && isNameStart(c)) return true;
    return validEscape(k);
  };

  const startsNumber = (k: number) => {
    const c = at(k);
    if (c === 0x2b || c === 0x2d) return isDigit(at(k + 1)) || (at(k + 1) === 0x2e && isDigit(at(k + 2)));
    if (c === 0x2e) return isDigit(at(k + 1));
    return isDigit(c);
  };

  // Runs of plain code points are sliced, not added one by one.
  const name = (k: number): [string, number] => {
    let out = '';
    let run = k;
    for (;;) {
      const c = at(k);
      if (c > 0 && isName(c)) k++;
      else if (c === 0) {
        out += `${css.slice(run, k)}�`;
        run = ++k;
      } else if (validEscape(k)) {
        const [s, j] = escape(k + 1);
        out += css.slice(run, k) + s;
        run = k = j;
      } else return [out + css.slice(run, k), k];
    }
  };

  const numberEnd = (k: number) => {
    if (at(k) === 0x2b || at(k) === 0x2d) k++;
    while (isDigit(at(k))) k++;
    if (at(k) === 0x2e && isDigit(at(k + 1))) {
      k += 2;
      while (isDigit(at(k))) k++;
    }
    const e = at(k);
    if (e === 0x45 || e === 0x65) {
      const s = at(k + 1);
      if (isDigit(s)) k += 2;
      else if ((s === 0x2b || s === 0x2d) && isDigit(at(k + 2))) k += 3;
      else return k;
      while (isDigit(at(k))) k++;
    }
    return k;
  };

  const badUrlEnd = (k: number) => {
    for (;;) {
      const c = at(k);
      if (c === -1) return k;
      if (c === 0x29) return k + 1;
      if (validEscape(k)) k = escape(k + 1)[1];
      else k++;
    }
  };

  // After "url(": a url token, or a bad one.
  const url = (k: number): [TokenType, string, number] => {
    while (isWhitespace(at(k))) k++;
    let out = '';
    let run = k;
    for (;;) {
      const c = at(k);
      if (c === 0x29) return ['url', out + css.slice(run, k), k + 1];
      if (c === -1) return ['url', out + css.slice(run, k), k];
      if (isWhitespace(c)) {
        out += css.slice(run, k);
        while (isWhitespace(at(k))) k++;
        if (at(k) === 0x29) return ['url', out, k + 1];
        if (at(k) === -1) return ['url', out, k];
        return ['bad-url', out, badUrlEnd(k)];
      }
      if (c === 0x22 || c === 0x27 || c === 0x28 || isNonPrintable(c)) return ['bad-url', out + css.slice(run, k), badUrlEnd(k)];
      if (c === 0x5c) {
        if (!validEscape(k)) return ['bad-url', out + css.slice(run, k), badUrlEnd(k)];
        const [s, j] = escape(k + 1);
        out += css.slice(run, k) + s;
        run = k = j;
        continue;
      }
      if (c === 0) {
        out += `${css.slice(run, k)}�`;
        run = k + 1;
      }
      k++;
    }
  };

  // After the opening quote.
  const string = (k: number, quote: number): [TokenType, string, number] => {
    let out = '';
    let run = k;
    for (;;) {
      const c = at(k);
      if (c === quote) return ['string', out + css.slice(run, k), k + 1];
      if (c === -1) return ['string', out + css.slice(run, k), k];
      if (isNewline(c)) return ['bad-string', out + css.slice(run, k), k];
      if (c === 0x5c) {
        out += css.slice(run, k);
        const d = at(k + 1);
        if (d === -1) k++;
        else if (isNewline(d)) k += d === 0x0d && at(k + 2) === 0x0a ? 3 : 2;
        else {
          const [s, j] = escape(k + 1);
          out += s;
          k = j;
        }
        run = k;
        continue;
      }
      if (c === 0) {
        out += `${css.slice(run, k)}�`;
        run = k + 1;
      }
      k++;
    }
  };

  const identLike = (start: number): Token => {
    const [nm, k] = name(start);
    if (lowerAscii(nm) === 'url' && at(k) === 0x28) {
      let j = k + 1;
      while (isWhitespace(at(j)) && isWhitespace(at(j + 1))) j++;
      const next = isWhitespace(at(j)) ? at(j + 1) : at(j);
      if (next === 0x22 || next === 0x27) return { type: 'function', start, end: k + 1, value: nm };
      const [type, value, end] = url(k + 1);
      return { type, start, end, value };
    }
    if (at(k) === 0x28) return { type: 'function', start, end: k + 1, value: nm };
    return { type: 'ident', start, end: k, value: nm };
  };

  const numeric = (start: number): Token => {
    const k = numberEnd(start);
    if (startsIdent(k)) {
      const [unit, e] = name(k);
      return { type: 'dimension', start, end: e, value: unit };
    }
    if (at(k) === 0x25) return { type: 'percentage', start, end: k + 1, value: '' };
    return { type: 'number', start, end: k, value: '' };
  };

  const out: Token[] = [];
  let i = 0;
  const push = (t: Token) => {
    out.push(t);
    i = t.end;
  };
  const delim = () => push({ type: 'delim', start: i, end: i + 1, value: css[i]! });
  while (i < n) {
    const c = at(i);
    if (c === 0x2f && at(i + 1) === 0x2a) {
      const e = css.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
    } else if (isWhitespace(c)) {
      let e = i;
      while (isWhitespace(at(e))) e++;
      push({ type: 'whitespace', start: i, end: e, value: '' });
    } else if (c === 0x22 || c === 0x27) {
      const [type, value, end] = string(i + 1, c);
      push({ type, start: i, end, value });
    } else if (c === 0x23) {
      if ((at(i + 1) !== -1 && isName(at(i + 1))) || validEscape(i + 1)) {
        const [nm, e] = name(i + 1);
        push({ type: 'hash', start: i, end: e, value: nm });
      } else delim();
    } else if (SINGLE.has(c)) {
      push({ type: css[i] as TokenType, start: i, end: i + 1, value: '' });
    } else if (c === 0x2b || c === 0x2e) {
      if (startsNumber(i)) push(numeric(i));
      else delim();
    } else if (c === 0x2d) {
      if (startsNumber(i)) push(numeric(i));
      else if (at(i + 1) === 0x2d && at(i + 2) === 0x3e) push({ type: 'CDC', start: i, end: i + 3, value: '' });
      else if (startsIdent(i)) push(identLike(i));
      else delim();
    } else if (c === 0x3c) {
      if (css.startsWith('!--', i + 1)) push({ type: 'CDO', start: i, end: i + 4, value: '' });
      else delim();
    } else if (c === 0x40) {
      if (startsIdent(i + 1)) {
        const [nm, e] = name(i + 1);
        push({ type: 'at-keyword', start: i, end: e, value: nm });
      } else delim();
    } else if (c === 0x5c) {
      if (validEscape(i)) push(identLike(i));
      else delim();
    } else if (isDigit(c)) {
      push(numeric(i));
    } else if (isNameStart(c)) {
      push(identLike(i));
    } else delim();
  }
  return out;
}
