// pdfkiln serve: Chromium kept open for this user's conversions, which
// connect to it by themselves (src/engine/server.ts).
import { writeSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LaunchError } from '../engine/browser.js';
import { noAliasEnv, qtDefaultFamily } from '../engine/fonts.js';
import { serve, socketPath } from '../engine/server.js';

const HELP = `Usage: pdfkiln serve [options]

Keeps Chromium open for this user's conversions: pdfkiln, wkhtmltopdf and
wkhtmltoimage connect to it by themselves and skip its start-up, each in a
browser context of its own. It listens on sockets only this user can open,
never on a TCP port. Stop it with Ctrl+C or SIGTERM.

On Linux, pdfkiln gets a Chromium of its own, started at its first
conversion: it renders with the system's fonts, where wkhtmltopdf and
wkhtmltoimage emulate those of wkhtmltopdf.

Options:
  --socket <path>   Where wkhtmltopdf and wkhtmltoimage connect; pdfkiln
                    connects beside it, -native added to the name
                    (chromium-native.sock). Default: run/chromium.sock in
                    the cache folder, ~/.cache/pdfkiln on Linux;
                    \\\\.\\pipe\\pdfkiln-<user> on Windows. The commands look
                    there too, or in PDFKILN_SERVER ("off": nowhere).
  --no-sandbox      Run Chromium without its sandbox (not recommended)
  -h, --help        Show this help
`;

const stderr = (s: string) => writeSync(2, s);

export async function serveMain(args: string[]): Promise<number> {
  let values: { socket?: string; 'no-sandbox'?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args, options: { socket: { type: 'string' }, 'no-sandbox': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (e) {
    stderr(`pdfkiln serve: ${e instanceof Error ? e.message : String(e)}\n\n${HELP}`);
    return 1;
  }
  if (values.help) {
    writeSync(1, HELP);
    return 0;
  }
  const socket = values.socket ?? socketPath();
  if (!socket) {
    stderr('pdfkiln serve: no socket, PDFKILN_SERVER is "off" or this account has no name for the pipe: give --socket\n');
    return 1;
  }
  if (values['no-sandbox']) stderr("pdfkiln serve: Chromium's sandbox is off (--no-sandbox)\n");
  try {
    return await serve({
      socket,
      noSandbox: Boolean(values['no-sandbox']),
      // As for one conversion of the compatible mode.
      env: (dir) => (qtDefaultFamily() ? noAliasEnv(dir) : {}),
      log: (line) => stderr(`${line}\n`),
    });
  } catch (e) {
    if (e instanceof LaunchError) {
      stderr(`pdfkiln serve: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
