#!/usr/bin/env node
// The wkhtmltoimage command of the npm package.
import { enableCompileCache } from 'node:module';

enableCompileCache?.();
void import('../cli.js').then(({ main }) => main('wkhtmltoimage', process.argv.slice(2))).then((code) => process.exit(code));
