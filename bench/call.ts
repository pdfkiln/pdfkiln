// One complete call of the pdfkiln command (bundled, as shipped) against
// wkhtmltopdf 0.12.6, on a corpus entry: the README figure.
//
//   npm run bundle && node dist/bench/call.js [--entry odoo17-invoice-long] [--delay 200] [--runs 15] [--exe path/to/wkhtmltopdf]
//                                             [--server] [--no-wkhtmltopdf]
//
// --server: pdfkiln serve is started on a socket of the bench's own, and
// each round also runs the command through it, against the command alone
// (PDFKILN_SERVER=off); not on Windows, where pdfkiln serve is off.
// --no-wkhtmltopdf: pdfkiln only, where there is no
// wkhtmltopdf 0.12.6 to run (macOS).
//
// Output: bench/out/call/call-<entry>-delay<ms>[-server].json, with the
// median of each step of the command (PDFKILN_TIMINGS).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { killTree, removeQuietly } from '../src/engine/browser.js';
import { prepare } from './entry.js';
import { repoRoot, run, runWkhtmltopdf, writeJson } from './wk.js';

const { values } = parseArgs({
  options: {
    entry: { type: 'string', default: 'odoo17-invoice-long' },
    delay: { type: 'string' },
    runs: { type: 'string', default: '15' },
    exe: { type: 'string' },
    server: { type: 'boolean' },
    'no-wkhtmltopdf': { type: 'boolean' },
  },
});
const out = join(repoRoot, 'bench', 'out', 'call');
mkdirSync(out, { recursive: true });
// --exe: a packaged wkhtmltopdf (the single executable's link) instead of the bundle.
const cli = join(repoRoot, 'dist', 'bundle', 'wkhtmltopdf.cjs');
const command = (a: string[]): [string, string[]] => (values.exe ? [values.exe, a] : [process.execPath, [cli, ...a]]);
const pdfkiln = (a: string[]): [string, string[]] => values.exe
  ? [join(dirname(values.exe), process.platform === 'win32' ? 'pdfkiln.exe' : 'pdfkiln'), a]
  : [process.execPath, [join(repoRoot, 'dist', 'bundle', 'pdfkiln.cjs'), ...a]];

// pdfkiln serve, in a temporary folder of its own (its socket, and its
// Chromium profile through TMPDIR), stopped with its Chromium at the end.
async function startServer(): Promise<{ socket: string; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'pdfkiln-bench-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\pdfkiln-bench-${process.pid}` : join(dir, 'run', 'chromium.sock');
  const child: ChildProcess = spawn(...pdfkiln(['serve', '--socket', socket]), {
    env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stderr = '';
  await new Promise<void>((ok, fail) => {
    child.stderr!.on('data', (d) => {
      stderr += d;
      if (stderr.includes('serving on')) ok();
    });
    child.once('exit', (code) => fail(new Error(`pdfkiln serve exited with ${code}: ${stderr}`)));
  });
  return {
    socket,
    stop: async () => {
      // SIGTERM lets it stop Chromium; Windows has no signal, its tree goes.
      const exited = new Promise((ok) => child.once('exit', ok));
      if (process.platform === 'win32') killTree(child.pid);
      else child.kill('SIGTERM');
      await Promise.race([exited, new Promise((ok) => setTimeout(ok, 5000))]);
      removeQuietly(dir);
    },
  };
}

const e = await prepare(values.entry!);
let args = e.wkArgs('{out}');
if (values.delay) {
  const i = args.indexOf('--javascript-delay');
  args = i >= 0 ? args.map((a, j) => (j === i + 1 ? values.delay! : a)) : ['--javascript-delay', values.delay, ...args];
}
const delay = args[args.indexOf('--javascript-delay') + 1] ?? '200';
const withOut = (f: string) => args.map((a) => (a === '{out}' ? join(out, f) : a));

if (values.server && process.platform === 'win32') throw new Error('--server: pdfkiln serve is off on Windows');
const server = values.server ? await startServer() : undefined;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const wk: number[] = [];
const ours: number[] = [];
const served: number[] = [];
const steps: Record<string, number>[] = [];
const servedSteps: Record<string, number>[] = [];
const ourCall = async (env: NodeJS.ProcessEnv, f: string) => {
  const p = await run(...command(withOut(f)), { cwd: e.dir, stdin: e.stdin, env: { ...process.env, PDFKILN_TIMINGS: '1', ...env } });
  if (p.code !== 0) throw new Error(`pdfkiln: ${p.stderr}`);
  return { ms: p.ms, steps: JSON.parse(p.stderr.trim().split('\n').pop()!) as Record<string, number> };
};
try {
  // One warm-up round, then the tools alternate.
  for (let i = -1; i < Number(values.runs); i++) {
    if (!values['no-wkhtmltopdf']) {
      const w = await runWkhtmltopdf(withOut('wk.pdf'), { cwd: e.dir, stdin: e.stdin });
      if (w.code !== 0) throw new Error(`wkhtmltopdf: ${w.stderr}`);
      if (i >= 0) wk.push(w.ms);
    }
    const p = await ourCall(server ? { PDFKILN_SERVER: 'off' } : {}, 'pdfkiln.pdf');
    const s = server ? await ourCall({ PDFKILN_SERVER: server.socket }, 'pdfkiln-served.pdf') : undefined;
    if (s && !s.steps.served) throw new Error('pdfkiln did not connect to pdfkiln serve');
    if (i < 0) continue;
    ours.push(p.ms);
    steps.push(p.steps);
    if (s) {
      served.push(s.ms);
      servedSteps.push(s.steps);
    }
  }
} finally {
  await server?.stop();
}
const medians = (xs: Record<string, number>[]) => Object.fromEntries(Object.keys(xs[0]!).map((k) => [k, median(xs.map((s) => s[k]!))]));
const result = {
  entry: values.entry,
  delay: Number(delay),
  runs: ours.length,
  median: {
    ...(wk.length ? { wkhtmltopdf: Math.round(median(wk)) } : {}),
    pdfkiln: Math.round(median(ours)),
    ...(served.length ? { served: Math.round(median(served)) } : {}),
  },
  ...(wk.length ? { difference: Math.round(median(ours) - median(wk)) } : {}),
  ...(served.length ? { gain: Math.round(median(ours) - median(served)) } : {}),
  steps: medians(steps),
  ...(served.length ? { servedSteps: medians(servedSteps) } : {}),
};
writeJson(join(out, `call-${values.entry}-delay${delay}${server ? '-server' : ''}.json`), result);
console.log(JSON.stringify(result));
e.close();
