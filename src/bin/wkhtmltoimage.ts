#!/usr/bin/env node
// The wkhtmltoimage command of the npm package.
import { enableCompileCache } from 'node:module';
import { cleanup, markHelperEntry } from '../engine/cleanup.js';

// Left behind by a conversion on Windows: removes its folder, and nothing
// else (src/engine/cleanup.ts).
if (process.env.PDFKILN_CLEANUP) cleanup(process.env.PDFKILN_CLEANUP);
else {
  markHelperEntry();
  enableCompileCache?.();
  void import('../cli.js').then(({ main }) => main('wkhtmltoimage', process.argv.slice(2))).then((code) => process.exit(code));
}
