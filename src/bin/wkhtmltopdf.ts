#!/usr/bin/env node
// The wkhtmltopdf command of the npm package.
import { enableCompileCache } from 'node:module';
import { compileCacheDir } from '../cache-dir.js';

enableCompileCache?.(compileCacheDir());
void import('../cli.js').then(({ main }) => main('wkhtmltopdf', process.argv.slice(2))).then((code) => process.exit(code));
