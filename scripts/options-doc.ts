// docs/options.md: the options of the compatible mode, from the tables the
// parsers use (src/wk/options.ts, src/wk/image.ts), so that they cannot
// drift apart;
// test/options.test.ts checks the file is current.
//
//   node dist/scripts/options-doc.js
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '../src/chromium.js';
import { IMAGE_OPTIONS } from '../src/wk/image.js';
import { KILN_OPTIONS, OPTIONS, type OptionSpec, type Support } from '../src/wk/options.js';

const SECTIONS: Record<OptionSpec['mode'], string> = { global: 'global', page: 'page', toc: 'toc' };

function table(options: OptionSpec[], sections = true): string {
  const rows = options.map((o) => {
    const name = `\`--${o.name}${o.args.map((a) => ` <${a}>`).join('')}\``;
    const section = sections ? ` ${SECTIONS[o.mode]} |` : '';
    return `| ${name} | ${o.short ? `\`-${o.short}\`` : ''} |${section} ${o.desc.replace(/\|/g, '\\|')} |`;
  });
  const head = sections ? ['| Option | Short | Section | Description |', '| --- | --- | --- | --- |'] : ['| Option | Short | Description |', '| --- | --- | --- |'];
  return [...head, ...rows].join('\n');
}

export function optionsMarkdown(): string {
  const of = (...s: Support[]) => OPTIONS.filter((o) => s.includes(o.support));
  return `# Options of the compatible mode

Called as \`wkhtmltopdf\`, PDFKiln accepts the ${OPTIONS.length} options of wkhtmltopdf 0.12.6, with the same sections: global options before the first page (page options there are defaults for every page), page options after a page or \`cover\`. Generated from \`src/wk/options.ts\` by \`node dist/scripts/options-doc.js\`.

## Implemented (${of('yes').length})

${table(of('yes'))}

## Accepted without effect (${of('noop', 'silent').length})

A warning unless \`--quiet\`, never an effect on the exit code; none for \`--lowquality\`, which knp-snappy passes on every call, nor for the options that restate the default.

${table(of('noop', 'silent'))}

## Ours

${table(KILN_OPTIONS)}

## Kept as in wkhtmltopdf 0.12.6

\`--no-custom-header-propagation\` turns the propagation on, like \`--custom-header-propagation\`: a mistake in wkhtmltopdf's code, which the commands written for it rely on.

## wkhtmltoimage

Called as \`wkhtmltoimage\`, PDFKiln accepts the ${IMAGE_OPTIONS.length} options of wkhtmltoimage 0.12.6, all global, followed by the input and the output; ${IMAGE_OPTIONS.filter((o) => o.support === 'yes').length} have an effect, the others are accepted without effect, as in wkhtmltopdf. The \`--kiln-\` options above apply too.

${table([...IMAGE_OPTIONS].sort((a, b) => a.name.localeCompare(b.name)), false)}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(join(repoRoot, 'docs', 'options.md'), optionsMarkdown());
}
