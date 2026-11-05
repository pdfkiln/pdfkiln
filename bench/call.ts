// One complete call of the pdfkiln command (bundled, as shipped) against
// wkhtmltopdf 0.12.6, on a corpus entry: the README figure.
//
//   npm run bundle && node dist/bench/call.js [--entry odoo17-invoice-long] [--delay 200] [--runs 15] [--exe path/to/wkhtmltopdf]
//                                             [--no-wkhtmltopdf] [--native [--relay]] [--base <folder>]
//
// --no-wkhtmltopdf: pdfkiln only, where there is no wkhtmltopdf 0.12.6 to
// run (macOS). --native: pdfkiln's own interface on the entry's pages
// (pdfkiln -q --allow-private-network --javascript-delay <ms> <pages>
// <out>: the entry's resources come from 127.0.0.1) in place of the
// wkhtmltopdf command line; with --relay, without --allow-private-network,
// as by default: the relay runs, for an entry without a server
// (sylius-invoice). --base: each round also runs the bundle in that
// folder, a copy of dist/bundle made before a change, in turns with the
// current one: the gain of the change, also as the median of the gains of
// each round.
//
// Output: bench/out/call/call-<entry>-delay<ms>[-native][-base].json, with
// the median of each step of the command (PDFKILN_TIMINGS).
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    native: { type: 'boolean' },
    relay: { type: 'boolean' },
    base: { type: 'string' },
  },
});
if (values.exe && values.base) throw new Error('--base compares two bundles: not with --exe');
const out = join(repoRoot, 'bench', 'out', 'call');
mkdirSync(out, { recursive: true });

const e = await prepare(values.entry!);
let args = e.wkArgs('{out}');
if (values.delay) {
  const i = args.indexOf('--javascript-delay');
  args = i >= 0 ? args.map((a, j) => (j === i + 1 ? values.delay! : a)) : ['--javascript-delay', values.delay, ...args];
}
const delay = args[args.indexOf('--javascript-delay') + 1] ?? '200';

// The command in a bundle folder, or --exe: a packaged wkhtmltopdf (the
// single executable's link) and the pdfkiln beside it.
const commandIn = (bundle: string, f: string): [string, string[]] => {
  const a = values.native
    ? ['-q', ...(values.relay ? [] : ['--allow-private-network']), '--javascript-delay', delay, ...e.call.pages, join(out, f)]
    : args.map((x) => (x === '{out}' ? join(out, f) : x));
  if (values.exe) return [values.native ? join(dirname(values.exe), process.platform === 'win32' ? 'pdfkiln.exe' : 'pdfkiln') : values.exe, a];
  return [process.execPath, [join(bundle, values.native ? 'pdfkiln.cjs' : 'wkhtmltopdf.cjs'), ...a]];
};
const current = join(repoRoot, 'dist', 'bundle');
const base = values.base ? resolve(values.base) : undefined;
const call = async (bundle: string, f: string) => {
  const p = await run(...commandIn(bundle, f), { cwd: e.dir, stdin: e.stdin, env: { ...process.env, PDFKILN_TIMINGS: '1' } });
  if (p.code !== 0) throw new Error(`pdfkiln (${bundle}): ${p.stderr}`);
  return { ms: p.ms, steps: JSON.parse(p.stderr.trim().split('\n').pop()!) as Record<string, number> };
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const medians = (xs: Record<string, number>[]) => Object.fromEntries(Object.keys(xs[0]!).map((k) => [k, median(xs.map((s) => s[k] ?? 0))]));
const wk: number[] = [];
const ours: number[] = [];
const steps: Record<string, number>[] = [];
const based: number[] = [];
const baseSteps: Record<string, number>[] = [];
// One warm-up round, then the tools alternate; with --base, the two
// bundles change places each round.
for (let i = -1; i < Number(values.runs); i++) {
  if (!values['no-wkhtmltopdf']) {
    const w = await runWkhtmltopdf(args.map((x) => (x === '{out}' ? join(out, 'wk.pdf') : x)), { cwd: e.dir, stdin: e.stdin });
    if (w.code !== 0) throw new Error(`wkhtmltopdf: ${w.stderr}`);
    if (i >= 0) wk.push(w.ms);
  }
  const b = base && i % 2 === 0 ? await call(base, 'pdfkiln-base.pdf') : undefined;
  const p = await call(current, 'pdfkiln.pdf');
  const b2 = base && i % 2 !== 0 ? await call(base, 'pdfkiln-base.pdf') : b;
  if (i < 0) continue;
  ours.push(p.ms);
  steps.push(p.steps);
  if (b2) {
    based.push(b2.ms);
    baseSteps.push(b2.steps);
  }
}
const result = {
  entry: values.entry,
  ...(values.native ? { native: true } : {}),
  ...(values.relay ? { relay: true } : {}),
  delay: Number(delay),
  runs: ours.length,
  median: {
    ...(wk.length ? { wkhtmltopdf: Math.round(median(wk)) } : {}),
    pdfkiln: Math.round(median(ours)),
    ...(based.length ? { base: Math.round(median(based)) } : {}),
  },
  ...(wk.length ? { difference: Math.round(median(ours) - median(wk)) } : {}),
  ...(based.length ? { gain: Math.round(median(based) - median(ours)), pairedGain: Math.round(median(based.map((x, k) => x - ours[k]!))) } : {}),
  steps: medians(steps),
  ...(baseSteps.length ? { baseSteps: medians(baseSteps) } : {}),
};
writeJson(join(out, `call-${values.entry}-delay${delay}${values.native ? '-native' : ''}${values.relay ? '-relay' : ''}${base ? '-base' : ''}.json`), result);
console.log(JSON.stringify(result));
e.close();
