// --cookie-jar: cookies read before loading and written after, in the
// format of Qt's QNetworkCookie::toRawForm, one cookie per line ending
// with ";" (src/lib/multipageloader.cc MyCookieJar).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface JarCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number; // seconds since 1970
  secure?: boolean;
  httpOnly?: boolean;
}

// A jar that cannot be read or written is left as it is, without a word
// (multipageloader.cc MyCookieJar: loadFromFile, saveToFile).
function readable(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

export function readJar(path: string): JarCookie[] {
  const out: JarCookie[] = [];
  for (const line of readable(path).split('\n')) {
    const parts = line.trim().replace(/;$/, '').split(';').map((p) => p.trim()).filter(Boolean);
    const first = parts.shift();
    if (!first || !first.includes('=')) continue;
    const eq = first.indexOf('=');
    const c: JarCookie = { name: first.slice(0, eq), value: first.slice(eq + 1) };
    for (const p of parts) {
      const [k, ...v] = p.split('=');
      const key = k!.toLowerCase();
      const val = v.join('=');
      if (key === 'domain') c.domain = val;
      else if (key === 'path') c.path = val;
      else if (key === 'expires') {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) c.expires = t / 1000;
      } else if (key === 'secure') c.secure = true;
      else if (key === 'httponly') c.httpOnly = true;
    }
    out.push(c);
  }
  return out;
}

interface Named { name: string; value: string; domain?: string; path?: string }

// A cookie's identity in Qt's jar: its name, domain and path.
const keyOf = (c: Named) => `${c.name}\n${(c.domain ?? '').toLowerCase()}\n${c.path || '/'}`;
// One of --cookie, given to Chromium for a host.
const givenKey = (name: string, value: string, host: string) => `${name}\n${value}\n${host.toLowerCase()}`;

// A conversion's cookies as Qt's jar keeps them (QNetworkCookieJar), which
// Chromium, that holds them, does not: in order, those of --cookie-jar as
// read, then each cookie a server sets, last (setCookiesFromUrl), one
// whose value it changed included; and the file's cookies Chromium does
// not take (no domain, expired, a path that does not start with /).
export class QtJar {
  private ranks = new Map<string, { value: string; rank: number }>();
  private next = 0;
  private read: JarCookie[] = [];
  private taken = new Set<string>();
  private given = new Map<string, number>();

  // The cookies of the file, and those Chromium took.
  loaded(read: JarCookie[], taken: Named[]): void {
    this.read = read;
    this.taken = new Set(taken.map(keyOf));
    for (const c of read) this.rank(c);
  }

  // The cookies of --cookie that Chromium holds for the host of a page
  // loaded from its address: wkhtmltopdf sends them last, in their order,
  // and never writes them to the jar (MyCookieJar::useCookie).
  gave(cookies: [string, string][], host: string): void {
    for (const [name, value] of cookies) {
      const key = givenKey(name, value, host);
      if (!this.given.has(key)) this.given.set(key, this.given.size);
    }
  }

  private givenRank(c: Named): number | undefined {
    return this.given.get(givenKey(c.name, c.value, c.domain ?? ''));
  }

  private rank(c: Named): number {
    const key = keyOf(c);
    const r = this.ranks.get(key);
    if (r && r.value === c.value) return r.rank;
    this.ranks.set(key, { value: c.value, rank: this.next });
    return this.next++;
  }

  private ordered<T extends Named>(cookies: T[]): T[] {
    return cookies.map((c) => ({ c, rank: this.rank(c) })).sort((a, b) => a.rank - b.rank).map(({ c }) => c);
  }

  // The Cookie header of a request, from the cookies Chromium matches to
  // its URL (cookiesForUrl): the longest paths first, then in the jar's
  // order; a secure cookie over https only, where Chromium also gives it
  // to http://localhost. Then extra, --cookie's, sent whatever the URL
  // (MyCookieJar::useCookie). Empty without a cookie.
  line(cookies: (Named & { path: string; secure: boolean })[], url: string, extra: [string, string][] = []): string {
    const https = url.startsWith('https:');
    const sent = cookies.filter((c) => https || !c.secure);
    const given = sent.filter((c) => this.givenRank(c) !== undefined).sort((a, b) => this.givenRank(a)! - this.givenRank(b)!);
    return [
      ...this.ordered(sent.filter((c) => this.givenRank(c) === undefined)).sort((a, b) => b.path.length - a.path.length),
      ...given,
      ...extra.map(([name, value]) => ({ name, value })),
    ].map((c) => `${c.name}=${c.value}`).join('; ');
  }

  // The jar to write back (MyCookieJar::saveToFile), from the cookies
  // Chromium holds at the end, but those of --cookie: in the jar's order,
  // one unchanged as it was read (Chromium caps an expiry at 400 days),
  // and the file's cookies Chromium did not take, unless a server set one
  // in its place.
  toWrite(held: JarCookie[]): JarCookie[] {
    const read = new Map(this.read.map((c) => [keyOf(c), c]));
    const kept = held.flatMap((c) => {
      const r = read.get(keyOf(c));
      if (r && r.value === c.value) return [r];
      return this.givenRank(c) === undefined ? [c] : [];
    });
    const heldKeys = new Set(held.map(keyOf));
    return this.ordered([...kept, ...this.read.filter((c) => !this.taken.has(keyOf(c)) && !heldKeys.has(keyOf(c)))]);
  }
}

export function writeJar(path: string, cookies: JarCookie[]): void {
  const lines = cookies.map((c) => {
    let s = `${c.name}=${c.value}`;
    if (c.secure) s += '; secure';
    if (c.httpOnly) s += '; HttpOnly';
    if (c.expires && c.expires > 0) s += `; expires=${new Date(c.expires * 1000).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+)/, '$1, $2-$3-$4')}`;
    if (c.domain) s += `; domain=${c.domain}`;
    if (c.path) s += `; path=${c.path}`;
    return `${s};\n`;
  });
  try {
    writeFileSync(path, lines.join(''));
  } catch {
    // As wkhtmltopdf: the conversion goes on.
  }
}
