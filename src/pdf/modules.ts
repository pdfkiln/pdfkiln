// pdf-lib and the assembly, loaded on demand: their evaluation takes about
// 0.1 s, which the commands spend while Chromium starts, the main thread
// being idle then (LaunchOptions.meanwhile). Both modes call it after the
// launch; a second call costs nothing.
let loading: Promise<[typeof import('@cantoo/pdf-lib'), typeof import('./assemble.js')]> | undefined;

// pdf-lib pauses on a timer every 100 objects it reads and every 50 it
// writes, to keep a browser page responsive: 15 ms a pause on Windows,
// 1 ms on Linux, seconds for the tens of thousands of objects of a tagged
// PDF (81 pages: 4.9 s to read, 20.5 s to write on Windows). A command has
// nothing to keep responsive.
export const READ = { parseSpeed: Infinity, updateMetadata: false } as const;
export const WRITE = { objectsPerTick: Infinity } as const;

export function pdfModules(): Promise<[typeof import('@cantoo/pdf-lib'), typeof import('./assemble.js')]> {
  return (loading ??= Promise.all([import('@cantoo/pdf-lib'), import('./assemble.js')]));
}
