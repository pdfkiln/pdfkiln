// The Markdown corpus (bench/markdown/docs): each document converted by the
// native interface, several times, alternating; the median time of the
// call and of its Markdown step (PDFKILN_TIMINGS), its pages and warnings.
// The PDFs stay in bench/out/markdown/ to be looked at.
//
//   npm run build && node dist/bench/markdown.js [--runs 3] [--bundle] [name...]
//
// --bundle: dist/bundle/pdfkiln.cjs (npm run bundle) rather than the sources.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { PDFDocument } from '@cantoo/pdf-lib';
import { repoRoot } from '../src/chromium.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string' }, bundle: { type: 'boolean' } } });
const runs = Number(values.runs ?? 3);
const command = values.bundle ? join(repoRoot, 'dist', 'bundle', 'pdfkiln.cjs') : join(repoRoot, 'dist', 'src', 'bin', 'pdfkiln.js');
const docs = join(repoRoot, 'bench', 'markdown', 'docs');
const out = join(repoRoot, 'bench', 'out', 'markdown');
mkdirSync(out, { recursive: true });
const names = readdirSync(docs).filter((f) => f.endsWith('.md')).map((f) => basename(f, '.md')).filter((n) => !positionals.length || positionals.includes(n));

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const samples = new Map(names.map((n) => [n, { total: [] as number[], markdown: [] as number[], warnings: 0 }]));
for (let r = 0; r < runs; r++) {
  for (const name of names) {
    const t0 = performance.now();
    const p = spawnSync(process.execPath, [command, '--outline', join(docs, `${name}.md`), join(out, `${name}.pdf`)], { env: { ...process.env, PDFKILN_TIMINGS: '1' }, encoding: 'utf8' });
    const ms = performance.now() - t0;
    if (p.status !== 0) throw new Error(`${name}: exit ${p.status}\n${p.stderr}`);
    const s = samples.get(name)!;
    s.total.push(ms);
    s.markdown.push(JSON.parse(p.stderr.trim().split('\n').pop()!).markdown ?? 0);
    s.warnings = p.stderr.split('\n').filter((l) => l.includes('warning:')).length;
  }
}
const rows = [];
for (const name of names) {
  const s = samples.get(name)!;
  const pdf = readFileSync(join(out, `${name}.pdf`));
  const pages = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
  rows.push({ name, pages, ms: Math.round(median(s.total)), markdownMs: Math.round(median(s.markdown)), kb: Math.round(pdf.length / 1024), warnings: s.warnings });
}
console.table(rows);
writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ runs, command: values.bundle ? 'bundle' : 'sources', node: process.version, chromium: execFileSync(process.execPath, [command, '--version'], { encoding: 'utf8' }).trim(), rows }, null, 2)}\n`);
