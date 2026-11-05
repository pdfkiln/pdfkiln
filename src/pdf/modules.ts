// pdf-lib and the assembly, loaded on demand: their evaluation takes about
// 0.1 s, which the commands spend while Chromium starts, the main thread
// being idle then (LaunchOptions.meanwhile). Both modes call it after the
// launch; a second call costs nothing.
let loading: Promise<[typeof import('@cantoo/pdf-lib'), typeof import('./assemble.js')]> | undefined;

export function pdfModules(): Promise<[typeof import('@cantoo/pdf-lib'), typeof import('./assemble.js')]> {
  return (loading ??= Promise.all([import('@cantoo/pdf-lib'), import('./assemble.js')]));
}
