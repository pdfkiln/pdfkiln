# Prints the proof's documents through Odoo's own route, as the Print
# button of the web client does: logged in, GET /report/pdf/<report>/<ids>.
# Odoo renders the templates, writes the files and runs the engine.
#
#   python print.py <docs.json> <out dir> <engine>
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

docs_file, out, engine = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
base = 'http://127.0.0.1:8069'
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
login = json.dumps({'jsonrpc': '2.0', 'params': {'db': 'odoo', 'login': 'admin', 'password': 'admin'}}).encode()
answer = json.load(opener.open(urllib.request.Request(f'{base}/web/session/authenticate', login, {'Content-Type': 'application/json'})))
assert answer.get('result', {}).get('uid'), answer

rows = []
for name, (report, ids) in json.load(open(docs_file)).items():
    t = time.monotonic()
    try:
        r = opener.open(f'{base}/report/pdf/{report}/{",".join(map(str, ids))}', timeout=300)
        status, body = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read()
    ms = round((time.monotonic() - t) * 1000)
    pdf = status == 200 and body[:5] == b'%PDF-'
    with open(os.path.join(out, f'{name}.pdf' if pdf else f'{name}.error.html'), 'wb') as f:
        f.write(body)
    rows.append({'doc': name, 'status': status, 'pdf': pdf, 'ms': ms})
    print(f'{engine:22} {name:18} {status} {"PDF" if pdf else "no PDF"} {ms} ms', flush=True)
with open(os.path.join(out, 'print.json'), 'w') as f:
    json.dump(rows, f, indent=2)
