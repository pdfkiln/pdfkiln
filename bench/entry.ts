// Corpus entries: loading a manifest, serving its files, comparing PDFs.
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import { qtFamilies } from '../src/engine/fonts.js';
import type { RenderOptions } from '../src/render.js';
import { parseWkArgs, repoRoot, run, type WkCall } from './wk.js';

export interface Manifest {
  id: string;
  title: string;
  license: string;
  args: string[];
  stdin: string | null;
  versioned: boolean;
  www?: string[];
  httpHeaders?: Record<string, Record<string, string>>;
}

export const corpusDir = join(repoRoot, 'corpus');
const ORIGIN_TOKEN = 'http://127.0.0.1:8765';
const TEXT = new Set(['.html', '.htm', '.css', '.js', '.svg', '.json', '.txt']);
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
};

export function corpusIds(): string[] {
  return readdirSync(corpusDir).filter((d) => existsSync(join(corpusDir, d, 'manifest.json'))).sort();
}

export function python(): string {
  return process.env.PDFKILN_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
}

// bench/compare.py on two PDFs.
export async function compare(a: string, b: string, diffDir?: string): Promise<any> {
  const args = ['-I', join(repoRoot, 'bench', 'compare.py'), a, b];
  if (diffDir) {
    mkdirSync(diffDir, { recursive: true });
    args.push('--diff-dir', diffDir);
  }
  const r = await run(python(), args);
  if (r.code !== 0) throw new Error(`compare.py failed: ${r.stderr}`);
  return JSON.parse(r.stdout.toString('utf8'));
}

export async function pageCount(pdf: Uint8Array): Promise<number> {
  return (await PDFDocument.load(pdf)).getPageCount();
}

// Serves the entry's `www` directories, first match wins, with the
// manifest's headers; records the paths it could not find.
function serve(roots: string[], headers: Manifest['httpHeaders'], origin: () => string, misses: string[]): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = roots
      .map((root) => resolve(root, '.' + path))
      .find((f, i) => f.startsWith(resolve(roots[i]!)) && existsSync(f) && statSync(f).isFile());
    if (!file) {
      misses.push(path);
      res.writeHead(404).end();
      return;
    }
    const ext = extname(file).toLowerCase();
    let body: Buffer | string = readFileSync(file);
    if (TEXT.has(ext)) body = body.toString('utf8').replaceAll(ORIGIN_TOKEN, origin());
    const extra = Object.entries(headers ?? {})
      .filter(([prefix]) => path.startsWith(prefix))
      .reduce((acc, [, h]) => ({ ...acc, ...h }), {});
    res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', ...extra }).end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

function rewriteTree(dir: string, origin: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) rewriteTree(p, origin);
    else if (TEXT.has(extname(p).toLowerCase())) {
      const s = readFileSync(p, 'utf8');
      if (s.includes(ORIGIN_TOKEN)) writeFileSync(p, s.replaceAll(ORIGIN_TOKEN, origin));
    }
  }
}

export interface Prepared {
  manifest: Manifest;
  dir: string; // temporary copy of input/, the working directory of both tools
  misses: string[]; // paths the server could not find
  wkArgs(out: string): string[]; // the command line, for wkhtmltopdf or replay.js
  stdin?: string;
  call: WkCall; // the same command line, parsed, paths made absolute
  close(): void;
}

// Copies the entry to a temporary directory without dots (Odoo's header
// script reads the page index from the dots of the page path) and serves
// its files.
export async function prepare(id: string): Promise<Prepared> {
  const entry = join(corpusDir, id);
  const manifest = JSON.parse(readFileSync(join(entry, 'manifest.json'), 'utf8')) as Manifest;
  const dir = mkdtempSync(join(tmpdir(), 'pdfkilnbench'));
  const misses: string[] = [];
  let origin = '';
  const roots = (manifest.www ?? ['www']).map((d) => join(entry, d)).filter((d) => existsSync(d));
  const server = roots.length ? await serve(roots, manifest.httpHeaders, () => origin, misses) : undefined;
  const addr = server?.address();
  if (addr && typeof addr === 'object') origin = `http://127.0.0.1:${addr.port}`;
  cpSync(join(entry, 'input'), join(dir, 'input'), { recursive: true });
  if (origin) rewriteTree(join(dir, 'input'), origin);

  const call = parseWkArgs(manifest.args.map((a) => (a === '{out}' ? 'out.pdf' : a)));
  const abs = (p: string) =>
    p === '-' ? join(dir, manifest.stdin ?? 'stdin.html') : /^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : resolve(dir, p);
  call.pages = call.pages.map(abs);
  if (call.headerHtml) call.headerHtml = abs(call.headerHtml);
  if (call.footerHtml) call.footerHtml = abs(call.footerHtml);

  return {
    manifest,
    dir,
    misses,
    wkArgs: (out) => manifest.args.map((a) => (a === '{out}' ? out : a)),
    stdin: manifest.stdin ? join(dir, manifest.stdin) : undefined,
    call,
    close() {
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Rendering variants measured by the bench, cumulative: each adds one
// emulation of wkhtmltopdf to the previous one.
export interface Variant { env?: NodeJS.ProcessEnv; opts: RenderOptions }
export function variants(): Record<string, Variant> {
  const all: Record<string, Variant> = {
    plain: { opts: {} },
    truncate: { opts: { truncateTopMargin: true } },
  };
  if (process.platform === 'linux') {
    // wkhtmltopdf's fonts: Qt's families as installed, else its last
    // resort, what fontconfig gives for "Helvetica".
    const installed = execFileSync('fc-list', ['-f', '%{family[0]}\n', ':', 'family'], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
    const lastResort = execFileSync('fc-match', ['-f', '%{family[0]}', 'Helvetica'], { encoding: 'utf8' });
    all.wkfonts = {
      env: { FONTCONFIG_FILE: join(repoRoot, 'bench', 'fonts-noalias.conf') },
      opts: { truncateTopMargin: true, fontFamilies: qtFamilies(installed, lastResort) },
    };
  }
  const base = all.wkfonts ?? all.truncate!;
  all.wk = { env: base.env, opts: { ...base.opts, mediaViewport: [0, 0], roundFontSizes: true } };
  return all;
}
