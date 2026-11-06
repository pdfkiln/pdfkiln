// The v1 bench: replays every corpus entry with wkhtmltopdf 0.12.6 and with
// the pdfkiln command itself (compatible mode, same command line), then
// compares exit codes, page counts and text positions.
//
//   node dist/bench/compat.js [--gate] [id...]
//
// Output: bench/out/compat/<id>/ (PDFs, result.json, diff PNGs) and
// bench/out/compat/summary.json. --gate: exits 1 when the corpus misses the
// gate of a release, on Linux (bench/gate.ts).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { compare, corpusIds, pageCount, prepare } from './entry.js';
import { gateFailures } from './gate.js';
import { repoRoot, run, runWkhtmltopdf, writeJson, type RunResult } from './wk.js';

const outRoot = join(repoRoot, 'bench', 'out', 'compat');
const args = process.argv.slice(2);
const gate = args.includes('--gate');
const named = args.filter((a) => a !== '--gate');
const ids = named.length ? named : corpusIds();
const cli = join(repoRoot, 'dist', 'src', 'bin', 'wkhtmltopdf.js');
const strip = (s: string) => s.split(/[\r\n]+/).filter((l) => l.trim() && !l.startsWith('[')).map((l) => l.trimEnd());

// PDFKILN_WK_CACHE: a folder that keeps wkhtmltopdf's results, by entry.
// They do not change while the corpus, the bench and the system do not,
// on which ci.yml keys the folder; its time then is the first run's.
const wkCache = process.env.PDFKILN_WK_CACHE;
async function wkResult(id: string, pdf: string, runIt: () => Promise<RunResult>): Promise<Pick<RunResult, 'code' | 'ms' | 'stderr'>> {
  const kept = wkCache ? join(wkCache, id) : undefined;
  if (kept && existsSync(join(kept, 'result.json'))) {
    if (existsSync(join(kept, 'wk.pdf'))) copyFileSync(join(kept, 'wk.pdf'), pdf);
    return JSON.parse(readFileSync(join(kept, 'result.json'), 'utf8')) as Pick<RunResult, 'code' | 'ms' | 'stderr'>;
  }
  const r = await runIt();
  if (kept) {
    mkdirSync(kept, { recursive: true });
    if (existsSync(pdf)) copyFileSync(pdf, join(kept, 'wk.pdf'));
    writeJson(join(kept, 'result.json'), { code: r.code, ms: r.ms, stderr: r.stderr });
  }
  return r;
}

const summary: any[] = [];
for (const id of ids) {
  const out = join(outRoot, id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const e = await prepare(id);
  const wkPdf = join(out, 'wk.pdf');
  const ourPdf = join(out, 'pdfkiln.pdf');
  const wk = await wkResult(id, wkPdf, () => runWkhtmltopdf(e.wkArgs(wkPdf), { cwd: e.dir, stdin: e.stdin }));
  const ours = await run(process.execPath, [cli, ...e.wkArgs(ourPdf)], { cwd: e.dir, stdin: e.stdin });
  const row: any = {
    id,
    exit: { wkhtmltopdf: wk.code, pdfkiln: ours.code },
    ms: { wkhtmltopdf: Math.round(wk.ms), pdfkiln: Math.round(ours.ms) },
    stderr: { wkhtmltopdf: strip(wk.stderr), pdfkiln: strip(ours.stderr) },
  };
  if (existsSync(wkPdf) && existsSync(ourPdf)) {
    row.pages = { wkhtmltopdf: await pageCount(readFileSync(wkPdf)), pdfkiln: await pageCount(readFileSync(ourPdf)) };
    row.comparison = await compare(wkPdf, ourPdf, join(out, 'diff'));
  }
  writeJson(join(out, 'result.json'), row);
  summary.push(row);
  const c = row.comparison;
  console.log(`${id}: exit ${wk.code}/${ours.code}, pages ${row.pages?.wkhtmltopdf}/${row.pages?.pdfkiln}, words ${c ? c.same_page.words.join('/') : '-'}, on same page ${c ? (c.same_page.same_page * 100).toFixed(1) : '-'} %, median gaps ${c ? c.per_page.map((p: any) => p.text.median?.toFixed(1)).join(' ') : '-'} mm, ${row.ms.wkhtmltopdf}/${row.ms.pdfkiln} ms`);
  e.close();
}
writeJson(join(outRoot, 'summary.json'), summary);
// The corpus as a whole: of the words found in both PDFs, those on the same page.
const compared = summary.filter((r) => r.comparison);
const matched = compared.reduce((n, r) => n + r.comparison.same_page.matched, 0);
const same = compared.reduce((n, r) => n + r.comparison.same_page.same_page * r.comparison.same_page.matched, 0);
const samePages = compared.filter((r) => r.pages.wkhtmltopdf === r.pages.pdfkiln).length;
// Of wkhtmltopdf's words, those found in PDFKiln's PDF: what the gate
// would need to see text lost.
const wkWords = compared.reduce((n, r) => n + r.comparison.same_page.words[0], 0);
if (matched) console.log(`total: ${samePages}/${summary.length} with the same page count, ${((100 * same) / matched).toFixed(2)} % of ${matched} matched words on the same page, ${((100 * matched) / wkWords).toFixed(2)} % of wkhtmltopdf's ${wkWords} words found${process.env.PDFKILN_EMULATION ? ` (PDFKILN_EMULATION=${process.env.PDFKILN_EMULATION})` : ''}`);
if (gate) {
  if (process.platform !== 'linux') console.log(`gate: not applied on ${process.platform}, where the figures are an indicator`);
  else {
    const failures = gateFailures(summary);
    for (const f of failures) console.log(`gate: ${f}`);
    console.log(failures.length ? 'gate: missed' : 'gate: passed');
    if (failures.length) process.exitCode = 1;
  }
}
