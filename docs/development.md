# Development

Node.js 22.12 or later.

```sh
npm ci
npm run build
npm run fetch:chromium          # the pinned chrome-headless-shell, checked against chromium.json
npm run bundle                  # dist/bundle/pdfkiln.cjs and wkhtmltopdf.cjs
node dist/bundle/wkhtmltopdf.cjs page.html out.pdf
node dist/bundle/pdfkiln.cjs page.html out.pdf
```

Packages, for this platform:

```sh
node dist/scripts/sea.js                       # dist/sea/pdfkiln, the single executable
node dist/scripts/package.js                   # the archive (Windows: --launcher wkhtmltopdf.exe, from launcher/wkhtmltopdf.c)
node dist/scripts/deb.js                       # the Debian package, from the Linux archive
docker build -t pdfkiln -f docker/Dockerfile dist/package
node dist/scripts/npm.js                       # the npm package
```

On Ubuntu 23.10 and later, AppArmor restricts the user namespaces Chromium's sandbox needs: an AppArmor profile for the development binary allows them (see `.github/workflows/ci.yml`).

Tests and benches:

```sh
npm test                               # unit and command tests (PyMuPDF for the text checks)
npm run fetch:wkhtmltopdf              # the official wkhtmltopdf 0.12.6, for the benches
pip install -r bench/requirements.txt
npm run bench:compat                   # the corpus, PDFKiln against wkhtmltopdf
npm run bench:image                    # the corpus as images, against wkhtmltoimage
npm run bench:call                     # time of a complete call
npm run bench:markdown                 # the Markdown corpus: time, pages, warnings
test/libraries/run.sh /tmp/libs        # the libraries' own test suites
```
