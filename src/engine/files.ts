// Local files: what a page may read, and how it is served to Chromium.
// Every file: request is intercepted and answered from here, so the check
// runs outside the renderer, on the real path (links and ".." resolved).
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function canonical(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

// Where a file that may not exist would be: its nearest existing folder,
// resolved, then the rest of its path.
function whereItWouldBe(path: string): string | null {
  const rest: string[] = [];
  for (let p = path; ; p = dirname(p)) {
    const c = canonical(p);
    if (c) return join(c, ...rest);
    if (dirname(p) === p) return null;
    rest.unshift(basename(p));
  }
}

export class FileAccess {
  private readonly allowed = new Set<string>();

  // native: a missing file is checked where it would be. Called as
  // wkhtmltopdf, it is refused: wkhtmltopdf looks for a file's canonical
  // path among the allowed ones, and a missing file has none.
  constructor(readonly block: boolean, readonly native = false) {}

  // wkhtmltopdf allows the page itself and each --allow path, with what
  // lies under them (multipageloader.cc createRequest).
  allow(path: string): void {
    const c = canonical(path);
    if (c) this.allowed.add(c);
  }

  allows(path: string): boolean {
    if (!this.block) return true;
    let p = canonical(path) ?? (this.native ? whereItWouldBe(path) : null);
    if (!p) return false;
    for (let prev = ''; p !== prev; prev = p, p = dirname(p)) {
      if (this.allowed.has(p)) return true;
    }
    return false;
  }
}

// A path as Qt writes it: with / on Windows too.
export const qtPath = (path: string): string => (process.platform === 'win32' ? path.replace(/\\/g, '/') : path);

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'application/xhtml+xml', '.svg': 'image/svg+xml',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain', '.xml': 'text/xml', '.pdf': 'application/pdf',
};

export function contentType(path: string, encoding = ''): string {
  const t = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  // --encoding: the charset of documents that do not declare one.
  return encoding && t.startsWith('text/') ? `${t}; charset=${encoding}` : t;
}

export function filePath(url: string): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

export async function readLocal(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}
