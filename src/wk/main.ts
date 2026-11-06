// The compatible mode: called as wkhtmltopdf or wkhtmltoimage, or as
// "pdfkiln wkhtmltopdf" or "pdfkiln wkhtmltoimage".
import { readFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { convert, type Io } from './convert.js';
import { Feedback, IMAGE_PHASES } from './feedback.js';
import { license, usage, versionLine } from './help.js';
import { convertImage, imageUsage, imageVersionLine, parseImageArguments, type ImageParsed } from './image.js';
import { defaultObject } from './settings.js';
import { defaultTocXsl } from './toc.js';
import { ActionRequest, parseArguments, splitArgs, UsageError, type Parsed } from './parse.js';
import { handleError } from './qtnet.js';

const stderr = (s: string) => writeSync(2, s);
const stdout = (s: string) => writeSync(1, s);

function action(a: ActionRequest['action']): number {
  switch (a) {
    case 'version':
      stdout(`${versionLine()}\n`);
      return 0;
    case 'license':
      stdout(license());
      return 0;
    case 'dump-default-toc-xsl':
      stdout(defaultTocXsl(defaultObject().toc));
      return 0;
    default:
      stdout(usage());
      return 0;
  }
}

// Writes everything at once: a PDF on a pipe must not be cut by the exit.
function writeAll(fd: number, data: Uint8Array): void {
  for (let off = 0; off < data.length;) off += writeSync(fd, data, off);
}

function io(onTimeout: (line: string) => void): Io {
  return {
    stdin: () => readFileSync(0),
    stdout: (data) => writeAll(1, data),
    onTimeout,
  };
}

function parse(argv: string[], fromStdin = false): Parsed | number {
  try {
    return parseArguments(argv, fromStdin);
  } catch (e) {
    if (e instanceof ActionRequest) return action(e.action);
    if (e instanceof UsageError) {
      stderr(`${e.message}\n\n${usage()}`);
      return 1;
    }
    throw e;
  }
}

async function run(conversion: (fb: Feedback, io: Io) => Promise<{ success: boolean; errorCode: number }>, fb: Feedback): Promise<{ success: boolean; errorCode: number }> {
  try {
    return await conversion(fb, io((line) => {
      stderr(`${line}\n`);
      process.exit(1);
    }));
  } catch (e) {
    // wkhtmltopdf has no such failures: their cause is written even with
    // --quiet, or nothing would explain the exit code; then its last line,
    // which callers read, never a stack trace. A launch failure says what
    // to do about it.
    stderr(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    return { success: false, errorCode: 0 };
  }
}

// argv[0] is the program name, as in C.
export async function wkMain(argv: string[]): Promise<number> {
  const p = parse(argv);
  if (typeof p === 'number') return p;
  if (p.g.readArgsFromStdin) {
    // One conversion per line, as each line arrives, with the arguments of
    // the line added to those of the command (src/pdf/wkhtmltopdf.cc main,
    // a loop on fgets): a caller may wait for a PDF before the next line.
    for await (const l of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (!l.trim()) continue;
      const q = parse([...argv, ...splitArgs(l)], true);
      if (typeof q === 'number') return q;
      const r = await run((fb, x) => convert(q, fb, x), new Feedback(q.g.logLevel, stderr));
      if (!r.success) return 1;
    }
    return 0;
  }
  return finish(await run((fb, x) => convert(p, fb, x), new Feedback(p.g.logLevel, stderr)));
}

function finish(r: { success: boolean; errorCode: number }): number {
  const { code, line } = handleError(r.success, r.errorCode);
  if (line) stderr(`${line}\n`);
  return code;
}

// wkhtmltoimage: one page, one image.
export async function wkImageMain(argv: string[]): Promise<number> {
  let p: ImageParsed;
  try {
    p = parseImageArguments(argv);
  } catch (e) {
    if (e instanceof ActionRequest) {
      if (e.action === 'version') stdout(`${imageVersionLine()}\n`);
      else if (e.action === 'license') stdout(license().replace(versionLine(), imageVersionLine()));
      else stdout(imageUsage());
      return 0;
    }
    if (e instanceof UsageError) {
      stderr(`${e.message}\n\n${imageUsage()}`);
      return 1;
    }
    throw e;
  }
  return finish(await run((fb, x) => convertImage(p, fb, x), new Feedback(p.g.logLevel, stderr, IMAGE_PHASES)));
}
