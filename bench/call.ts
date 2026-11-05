// One complete call of the pdfkiln command (bundled, as shipped) against
// wkhtmltopdf 0.12.6, on a corpus entry: the README figure.
//
//   npm run bundle && node dist/bench/call.js [--entry odoo17-invoice-long] [--delay 200] [--runs 15] [--exe path/to/wkhtmltopdf]
//                                             [--no-wkhtmltopdf]
//
// --no-wkhtmltopdf: pdfkiln only, where there is no wkhtmltopdf 0.12.6 to
// run (macOS).
//
// Output: bench/out/call/call-<entry>-delay<ms>.json, with the median of
// each step of the command (PDFKILN_TIMINGS).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { prepare } from './entry.js';
import { repoRoot, run, runWkhtmltopdf, writeJson } from './wk.js';

const { values } = parseArgs({
  options: {
    entry: { type: 'string', default: 'odoo17-invoice-long' },
    delay: { type: 'string' },
    runs: { type: 'string', default: '15' },
    exe: { type: 'string' },
    'no-wkhtmltopdf': { type: 'boolean' },
  },
});
const out = join(repoRoot, 'bench', 'out', 'call');
mkdirSync(out, { recursive: true });
// --exe: a packaged wkhtmltopdf (the single executable's link) instead of the bundle.
const cli = join(repoRoot, 'dist', 'bundle', 'wkhtmltopdf.cjs');
const command = (a: string[]): [string, string[]] => (values.exe ? [values.exe, a] : [process.execPath, [cli, ...a]]);

const e = await prepare(values.entry!);
let args = e.wkArgs('{out}');
if (values.delay) {
  const i = args.indexOf('--javascript-delay');
  args = i >= 0 ? args.map((a, j) => (j === i + 1 ? values.delay! : a)) : ['--javascript-delay', values.delay, ...args];
}
const delay = args[args.indexOf('--javascript-delay') + 1] ?? '200';
const withOut = (f: string) => args.map((a) => (a === '{out}' ? join(out, f) : a));

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const wk: number[] = [];
const ours: number[] = [];
const steps: Record<string, number>[] = [];
// One warm-up round, then the tools alternate.
for (let i = -1; i < Number(values.runs); i++) {
  if (!values['no-wkhtmltopdf']) {
    const w = await runWkhtmltopdf(withOut('wk.pdf'), { cwd: e.dir, stdin: e.stdin });
    if (w.code !== 0) throw new Error(`wkhtmltopdf: ${w.stderr}`);
    if (i >= 0) wk.push(w.ms);
  }
  const p = await run(...command(withOut('pdfkiln.pdf')), { cwd: e.dir, stdin: e.stdin, env: { ...process.env, PDFKILN_TIMINGS: '1' } });
  if (p.code !== 0) throw new Error(`pdfkiln: ${p.stderr}`);
  if (i < 0) continue;
  ours.push(p.ms);
  steps.push(JSON.parse(p.stderr.trim().split('\n').pop()!) as Record<string, number>);
}
const result = {
  entry: values.entry,
  delay: Number(delay),
  runs: ours.length,
  median: {
    ...(wk.length ? { wkhtmltopdf: Math.round(median(wk)) } : {}),
    pdfkiln: Math.round(median(ours)),
  },
  ...(wk.length ? { difference: Math.round(median(ours) - median(wk)) } : {}),
  steps: Object.fromEntries(Object.keys(steps[0]!).map((k) => [k, median(steps.map((s) => s[k]!))])),
};
writeJson(join(out, `call-${values.entry}-delay${delay}.json`), result);
console.log(JSON.stringify(result));
e.close();
