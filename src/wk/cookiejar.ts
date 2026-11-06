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
