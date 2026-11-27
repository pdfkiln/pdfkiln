// The standard input, read whole, synchronously. Run by Node.js (the npm
// package), @puppeteer/browsers imports stdin from node:process: Node then
// opens the stream, and libuv makes fd 0 non-blocking, so that
// readFileSync(0) fails with EAGAIN as soon as the writer pauses (Python's
// pdfkit writes a long page in parts). The single executable, bundled,
// never reads that export. Here a read that would block waits a little and
// tries again.
import { readSync } from 'node:fs';

const pause = new Int32Array(new SharedArrayBuffer(4));

export function readStdin(): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(1 << 16);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 5);
        continue;
      }
      // Windows: the end of a pipe.
      if (code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}
