#!/usr/bin/env node
// The pdfkiln command. Installed as wkhtmltopdf too (a link, or the
// launcher on Windows), it switches to the compatible mode by its name.
// The compile cache is enabled before the modules are loaded.
import { enableCompileCache } from 'node:module';

enableCompileCache?.();
const name = process.argv0 && !/node(\.exe)?$/i.test(process.argv0) ? process.argv0 : 'pdfkiln';
void import('../cli.js').then(({ main }) => main(name, process.argv.slice(2))).then((code) => process.exit(code));
