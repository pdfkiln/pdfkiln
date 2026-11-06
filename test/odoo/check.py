# The pass condition of the proof for PDFKiln's setups (proof.sh,
# docker.sh): every document printed, and on every page text, the header
# (the company's name) and the footer (Odoo's page number), as
# summary.py found them. A PDF alone is not enough: a release that lost
# its headers would still make one.
#
#   python check.py <out dir> <engine>...
import json
import os
import sys

summary = json.load(open(os.path.join(sys.argv[1], 'summary.json')))
failures = []
for name in sys.argv[2:]:
    engine = summary['engines'].get(name)
    if not engine or not engine['docs']:
        failures.append(f'{name}: nothing printed')
        continue
    for doc, row in engine['docs'].items():
        if not row['pdf']:
            failures.append(f"{name} {doc}: no PDF (HTTP {row['status']})")
            continue
        for n, page in enumerate(row['pages'], 1):
            missing = [k for k in ('text', 'header', 'footer') if not page[k]]
            if missing:
                failures.append(f"{name} {doc}, page {n}: no {', no '.join(missing)}")
for f in failures:
    print(f)
sys.exit(1 if failures else 0)
