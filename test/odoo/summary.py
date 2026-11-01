# The proof's results on one platform (proof.sh): for each engine and
# document, the pages, and on each page whether the header (the company's
# name) and the footer (Odoo's page number) are there; each page rendered
# to PNG next to its PDF. Writes summary.json and summary.md.
#
#   python summary.py <out dir>
import json
import os
import sys

import pymupdf

out = sys.argv[1]
platform = json.load(open(os.path.join(out, 'platform.json')))
docs = list(json.load(open(os.path.join(out, 'docs.json'))))
engines = {}
for name in ['wkhtmltopdf-distro', 'wkhtmltopdf-0.12.6', 'paper-muncher', 'pdfkiln', 'pdfkiln-workers']:
    folder = os.path.join(out, name)
    if not os.path.isfile(os.path.join(folder, 'engine.json')):
        continue
    engine = json.load(open(os.path.join(folder, 'engine.json')))
    printed = os.path.join(folder, 'print.json')
    engine['docs'] = {}
    for row in json.load(open(printed)) if os.path.isfile(printed) else []:
        if row['pdf']:
            pages = []
            for n, page in enumerate(pymupdf.open(os.path.join(folder, row['doc'] + '.pdf'))):
                w, h = page.rect.width, page.rect.height
                pages.append({
                    'header': 'My Company' in page.get_text(clip=pymupdf.Rect(0, 0, w, h * 0.15)),
                    'footer': 'Page' in page.get_text(clip=pymupdf.Rect(0, h * 0.85, w, h)),
                })
                page.get_pixmap(dpi=60).save(os.path.join(folder, f"{row['doc']}-{n + 1}.png"))
            row['pages'] = pages
        engine['docs'][row['doc']] = row
    engines[name] = engine

with open(os.path.join(out, 'summary.json'), 'w') as f:
    json.dump({'platform': platform, 'engines': engines}, f, indent=2)


def cell(engine, doc):
    if not engine['installed']:
        return 'not installed'
    row = engine['docs'].get(doc)
    if not row:
        return 'not run'
    if not row['pdf']:
        return f"no PDF (HTTP {row['status']})"
    pages = row['pages']
    both = sum(p['header'] and p['footer'] for p in pages)
    return f"{len(pages)} p, header and footer on {both}, {row['ms']} ms"


lines = [
    f"### Odoo {platform['odoo']} on {platform['id']} {platform['version']} {platform['arch']}",
    '',
    f"Odoo {platform['odoo_commit']}, {platform['python']}, PostgreSQL {platform['postgresql']}",
    '',
    '| Engine | Version | ' + ' | '.join(docs) + ' |',
    '| --- | --- | ' + ' | '.join('---' for _ in docs) + ' |',
]
for name, engine in engines.items():
    version = engine['version'] or engine['note']
    lines.append(f'| {name} | {version} | ' + ' | '.join(cell(engine, d) for d in docs) + ' |')
with open(os.path.join(out, 'summary.md'), 'w') as f:
    f.write('\n'.join(lines) + '\n')
print('\n'.join(lines))
