# PDFKiln

Drop-in replacement for wkhtmltopdf, powered by Chromium.

Site, documentation and migration guides: [pdfkiln.org](https://pdfkiln.org)

wkhtmltopdf is archived: its last release, 0.12.6, dates from June 2020, on a Qt WebKit that gets no security fixes. Yet pdfkit, knp-snappy, laravel-snappy, phpwkhtmltopdf, wicked_pdf, Rotativa, Odoo and ERPNext still call it. PDFKiln takes its place without a line of your code changing: the same command line, a current Chromium underneath.

- **Same command line**: the 122 options of wkhtmltopdf 0.12.6, its defaults, messages and exit codes.
- **Same pages**: on 32 real templates (Odoo, ERPNext, Sylius, pandoc), the same page count as wkhtmltopdf on all 32, and 99.1 % of the words on the same page (Linux).
- **Tested by the libraries themselves**: the own test suites of pdfkit, knp-snappy, laravel-snappy, phpwkhtmltopdf, wicked_pdf, CakePdf and go-wkhtmltopdf pass with PDFKiln in place of wkhtmltopdf.
- **Kept current**: each release ships the latest stable Chromium, sandboxed; on Debian and Ubuntu, `apt upgrade` brings it.

PDFKiln is one program that answers to two names:

- called as `wkhtmltopdf` (or `pdfkiln wkhtmltopdf ...`), it accepts the command line of wkhtmltopdf 0.12.6, so existing integrations keep working unchanged;
- called as `pdfkiln`, it offers its own interface, with modern print defaults: print media, paper size, margins, headers and footers from the page's CSS (`@page` and its margin boxes). A few options give what the page cannot say itself: a style sheet of your own (`--css`), its screen rules (`--media screen`), the request's headers and cookies (`--header`, `--cookie`), an element to wait for (`--wait-for`), the PDF's title, author, subject and keywords (`--title`, `--author`, `--subject`, `--keywords`), no PDF rather than one without an image, a font or a style sheet that did not load (`--fail-on-resource-error`), PDF/A for archiving and Factur-X or ZUGFeRD invoices (`--pdfa`, `--factur-x`, below); `pdfkiln --help` lists them all. It prints Markdown too, which wkhtmltopdf never did: `pdfkiln notes.md notes.pdf`, or an http or https URL of a `.md` file, takes GitHub's dialect (tables, task lists, alerts, footnotes, emoji, raw HTML), math as `$...$` or `\(...\)`, and coloured code, lays it out for paper (page numbers, nothing cut across a page break), and takes the title, author and language from its front matter; `--css` adds to its style. It writes images too: `pdfkiln page.html page.png` captures the page in PNG, WebP or JPEG; and it takes PDFs made elsewhere among its inputs: `pdfkiln invoice.html terms.pdf invoice.pdf` puts the terms of sale after the invoice (below). This interface is young: unlike the wkhtmltopdf command line, it may change in a minor version, as in 1.1.0 and 1.2.0, and the version's notes (`CHANGELOG.md`) say so first.

PDFKiln is not affiliated with the original wkhtmltopdf project.

## Installation

Each package is self-contained: nothing else to install, except Chromium's system libraries on Linux, which the Debian package and the Docker image bring themselves.

**Debian and Ubuntu** (built for Debian 12 and 13 and Ubuntu 22.04 and later, tested on Ubuntu 24.04 and 26.04 and Debian 13; amd64 and arm64), from the signed APT repository, which brings Chromium's security fixes with `apt upgrade`:

```sh
curl -fsS https://apt.pdfkiln.org/pdfkiln-archive-keyring.asc | sudo tee /usr/share/keyrings/pdfkiln-archive-keyring.asc > /dev/null
printf 'Types: deb\nURIs: https://apt.pdfkiln.org\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/pdfkiln-archive-keyring.asc\n' \
  | sudo tee /etc/apt/sources.list.d/pdfkiln.sources
sudo apt update && sudo apt install pdfkiln
```

It installs `/usr/bin/pdfkiln` and `/usr/bin/wkhtmltopdf`, replaces the official `wkhtmltox` package, and loads an AppArmor profile so that Chromium's sandbox works on Ubuntu 24.04 and later. It recommends `fonts-noto-color-emoji`, which apt installs with it, for emoji in colour rather than empty boxes. The `.deb` of a [release](https://github.com/pdfkiln/pdfkiln/releases/latest), installed by hand, sets the repository up itself.

**Windows** (x64; ARM runs it in emulation; Windows Server with the Desktop Experience, IIS included, not Server Core, where Chromium stops at start and PDFKiln says so): from the [latest release](https://github.com/pdfkiln/pdfkiln/releases/latest), the installer `pdfkiln-<version>-windows-x64-setup.exe`, or the zip, which holds `wkhtmltopdf\bin\wkhtmltopdf.exe` as the old installer did. Both install in `C:\Program Files\wkhtmltopdf`, the path pdfkit and most guides use: uninstall wkhtmltopdf first. The programs are not signed yet: SmartScreen warns about the installer; check it against the release's `SHA256SUMS`.

**Linux and macOS archives** (Linux x64 and ARM64, macOS ARM64): the program, its Chromium, and `wkhtmltopdf` and `wkhtmltoimage` beside it. Unpack anywhere and put the folder in the `PATH`. On Linux, Chromium needs system libraries the archive does not hold, the ones the Debian package depends on; PDFKiln names those missing when Chromium cannot start. On Debian 13 and Ubuntu 24.04 and 26.04 (on Debian 12 and Ubuntu 22.04, the same names without `t64`), with the emoji font the Debian package recommends:

```sh
sudo apt install libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libdbus-1-3 libexpat1 libgbm1 \
  libglib2.0-0t64 libnspr4 libnss3 libudev1 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
  libxkbcommon0 libxrandr2 fontconfig fonts-liberation fonts-noto-color-emoji
```

**Docker** (amd64 and arm64), on Debian 13 slim, as an unprivileged user, with Liberation, DejaVu and the colour emoji font. Docker's default seccomp profile stops Chromium's sandbox; [`docker/seccomp.json`](docker/seccomp.json) is that profile plus the namespaces the sandbox needs:

```sh
curl -fsSO https://raw.githubusercontent.com/pdfkiln/pdfkiln/main/docker/seccomp.json
docker run --rm -i --security-opt seccomp=seccomp.json ghcr.io/pdfkiln/pdfkiln wkhtmltopdf - - < page.html > page.pdf
```

`--security-opt seccomp=unconfined` and `--cap-add SYS_ADMIN` work too, but drop the whole filter or grant a capability that helps escape a container: not recommended.

**PHP** (Composer, PHP 7.4 or later), for knp-snappy and the other PHP libraries: [`pdfkiln/pdfkiln`](https://packagist.org/packages/pdfkiln/pdfkiln) puts `wkhtmltopdf` and `wkhtmltoimage` in `vendor/bin` and downloads the program of the platform on first use, its SHA-256 checked; a version no project uses any more is deleted. It takes the place of packages that ship wkhtmltopdf itself, such as `h4cc/wkhtmltopdf-amd64`. On a Linux server, the Debian package or the Docker image is better: they bring Chromium's system libraries.

```sh
composer require pdfkiln/pdfkiln
```

```php
$snappy = new Knp\Snappy\Pdf(Pdfkiln\binary());
```

**npm** (Node.js 22.12 or later), for Node projects; Chromium is downloaded on first use into the user's cache, its SHA-256 checked, and deleted from it once no project uses that version any more. npm refuses the name `pdfkiln`, too close to `pdfkit`, hence the scope:

```sh
npx @pdfkiln/pdfkiln wkhtmltopdf page.html page.pdf
npm install -g @pdfkiln/pdfkiln    # pdfkiln, wkhtmltopdf and wkhtmltoimage
```

**Scoop** (Windows), the zip with its programs on the `PATH`:

```sh
scoop bucket add pdfkiln https://github.com/pdfkiln/scoop
scoop install pdfkiln/pdfkiln
```

**winget** (Windows x64), the installer, in `C:\Program Files\wkhtmltopdf`:

```sh
winget install pdfkiln
```

**Chocolatey** (Windows x64), the same installer:

```sh
choco install pdfkiln
```

**Homebrew** (macOS ARM64):

```sh
brew install pdfkiln/tap/pdfkiln
```

**GitHub Actions**: [`pdfkiln/setup`](https://github.com/pdfkiln/setup) installs it on the runner (Linux, macOS, Windows), for the tests of a project that calls wkhtmltopdf:

```yaml
- uses: pdfkiln/setup@v1
```

Chromium's sandbox stays on: run as an unprivileged user, not root.

## Status

The compatible mode is implemented: the 122 options of wkhtmltopdf 0.12.6 are accepted ([docs/options.md](docs/options.md): 98 implemented, 24 accepted without effect), pages, covers, the table of contents, text and HTML headers and footers with their variables, outlines, links between objects, copies, the network rules of wkhtmltopdf (local file access, `--allow`, cookies, custom headers, authentication, `--post`, client certificates, certificate errors ignored) and its layout quirks, emulated. Our own options start with `--kiln-`: `--kiln-timeout`, `--kiln-block-private-network`, `--kiln-block-invalid-certificates`, `--kiln-no-sandbox`.

The own test suites of pdfkit 1.0.0, knp-snappy 1.7.3, laravel-snappy 1.0.5, phpwkhtmltopdf 2.5.0, wicked_pdf 2.7.0, CakePdf 5.3.0 and go-wkhtmltopdf 1.9.3 pass with PDFKiln in place of wkhtmltopdf (`test/libraries/run.sh`, CI job `libraries`); go-wkhtmltopdf's with local images in place of those its test pages load from loremflickr.com, which answered 500 on 31 October 2026, and without its example that converts a page of pkg.go.dev, whose badge from codebeat.co no longer loads: wkhtmltopdf 0.12.6 fails on both, as PDFKiln does. knp-snappy's and CakePdf's suites only build command lines: a script for each also drives the program for real (`snappy-smoke.php`, `cakepdf-smoke.php`). KnpSnappyBundle 1.10.6's tests only check its configuration: with its binaries set to PDFKiln's, its services and responses return a PDF and a JPEG (`snappy-bundle-smoke.php`). imgkit 1.2.3's suite, run on wkhtmltoimage, passes 43 of 43 tests in the development container, as with wkhtmltoimage 0.12.6 (without its tests of xvfb, and of github.com, which the container cannot reach); the CI job runs it too.

Each release is built and tested by CI, then published by hand from two green runs (`.github/workflows/release.yml`, `apt.yml`, `npm.yml`, `docker.yml`), with SHA-256 sums and build provenance attestations (`gh attestation verify <file> --repo pdfkiln/pdfkiln`; up to 1.1.0, before the move to the pdfkiln organization, `--owner Jamalofski`).

## Migrating

Point the library at PDFKiln's `wkhtmltopdf` or `wkhtmltoimage`, never at `pdfkiln`: called by that name, it switches to its own interface. A step-by-step guide for each library is on the site: [pdfkiln.org/migrate](https://pdfkiln.org/migrate/).

| Library | Setting |
| --- | --- |
| [knp-snappy](https://pdfkiln.org/migrate/knp-snappy/) | `new Knp\Snappy\Pdf('/usr/bin/wkhtmltopdf')`; with the Composer package, `new Knp\Snappy\Pdf(Pdfkiln\binary())` |
| [laravel-snappy](https://pdfkiln.org/migrate/laravel-snappy/) | `WKHTML_PDF_BINARY=/usr/bin/wkhtmltopdf` in `.env` (`config/snappy.php`, `pdf.binary`) |
| [phpwkhtmltopdf](https://pdfkiln.org/migrate/phpwkhtmltopdf/) | `new mikehaertl\wkhtmlto\Pdf(['binary' => '/usr/bin/wkhtmltopdf'])`, or nothing if it is in the `PATH` |
| [pdfkit](https://pdfkiln.org/migrate/pdfkit/) (Python) | `pdfkit.configuration(wkhtmltopdf='/usr/bin/wkhtmltopdf')`, or nothing if it is in the `PATH` |
| [wicked_pdf](https://pdfkiln.org/migrate/wicked-pdf/) | `WickedPdf.config = { exe_path: '/usr/bin/wkhtmltopdf' }` in an initializer; drop the `wkhtmltopdf-binary` gem |
| [imgkit](https://pdfkiln.org/migrate/imgkit/) (Python) | `imgkit.config(wkhtmltoimage='/usr/bin/wkhtmltoimage')`, or nothing if it is in the `PATH` |
| [Odoo](https://pdfkiln.org/migrate/odoo/), [Frappe / ERPNext](https://pdfkiln.org/migrate/frappe/) | nothing: they find `wkhtmltopdf` in the `PATH` |
| [Rotativa](https://pdfkiln.org/migrate/rotativa/) (ASP.NET) | copy the content of `wkhtmltopdf\bin` (the programs and `chromium\`) into the Rotativa folder; tested with Rotativa.AspNetCore's driver, and in IIS as the application pool's identity on Windows Server with the Desktop Experience (not on Server Core, see Installation) |

With the Debian package, `/usr/bin/wkhtmltopdf` is already in the `PATH`. Libraries that read the version keep working: `wkhtmltopdf --version` prints `wkhtmltopdf 0.12.6 (with patched qt), pdfkiln <version>, Chromium <version>`.

## PDF/A and Factur-X

wkhtmltopdf wrote neither. `pdfkiln --pdfa` writes PDF/A for archiving, at level 2b, 2u, 3b or 3u (`--pdfa=2u`; 3b without a level), and `pdfkiln --factur-x invoice.xml` attaches an invoice's CII XML, Factur-X or ZUGFeRD, to a PDF/A-3: the page a person reads and the XML a program reads, in one file. Called as `wkhtmltopdf`, PDFKiln keeps the options of wkhtmltopdf 0.12.6 and adds none: these two are for `pdfkiln` only, as Markdown is.

```sh
pdfkiln --factur-x invoice.xml invoice.html invoice.pdf
```

- PDFKiln checks what it can: every font embedded (Chromium embeds them), a Unicode map for each font at the u levels, and in the XML a Cross Industry Invoice with its profile (MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED or XRECHNUNG), number, type and issue date. A PDF that cannot conform is refused, not labelled; a level or an invoice that is wrong is refused before the render.
- The XML is attached as its profile requires: `factur-x.xml`, or `xrechnung.xml` for XRECHNUNG; related as Data for MINIMUM and BASIC WL, which hold only part of the invoice, as Alternative otherwise.
- PDFKiln does not write the XML, which comes from the invoicing software, nor check it against the EN 16931 business rules.
- Not offered: PDF/A-1, which forbids the transparency Chromium draws with, and level A, which needs a fully tagged document.

## Images

`pdfkiln` writes an image instead of a PDF when the output is named `.png`, `.webp`, `.jpg` or `.jpeg`, or with `--to` (for the standard output): the preview of a shared link, a thumbnail, a picture in an email. The page is rendered in screen media, in a window 1280 pixels wide and 720 high, and the image holds the whole page, with the images that wait to be scrolled to (`loading="lazy"`) loaded.

```sh
pdfkiln https://example.com page.png
pdfkiln --width 1200 --height 630 card.html card.webp     # the window alone: 1200 x 630
pdfkiln --element "#chart" --scale 2 report.html chart.png
```

- `--width` and `--height` set the window; with `--height`, the image is the window alone. `--element` captures the first element that matches a CSS selector, wherever it is on the page. `--scale 2` doubles the pixels, for high-density screens.
- WebP is lossless, which keeps text sharp, unless `--quality` asks for less. JPEG takes a quality of 90 unless `--quality` says otherwise. `--transparent` leaves out the white behind a page that paints no background, in PNG and WebP.
- An image takes one input, HTML or Markdown, from a file, a URL or the standard input, under the rules of a PDF: the same access rules and options (`--css`, `--wait-for`, `--header`, `--cookie`, `--fail-on-resource-error`), and no image when the input does not load. Markdown is laid out in a column, as GitHub shows a README.
- WebP stops at 16383 pixels a side, JPEG at 65535: a longer page is refused, with its size; PNG, `--height` or `--element` capture it.

## PDF inputs

`pdfkiln` takes PDFs made elsewhere among its inputs, a file or an http or https URL named `.pdf`: their pages go into the output as they are, in the order of the inputs, before or after the pages it prints. The terms of sale after an invoice, an annex, a cover.

```sh
pdfkiln invoice.html terms.pdf invoice.pdf
pdfkiln cover.pdf report.md annex.pdf report.pdf
```

- A PDF's links to its own pages keep working, and with `--outline` its bookmarks join those of the printed pages. What its catalog holds stays out: a script run on opening, attached files. With a PDF first, the document takes its title.
- PDFs alone are merged without starting Chromium.
- A PDF from a URL is fetched under the rules of a page: no private address without `--allow-private-network`, its certificate checked unless `--allow-invalid-certificates`, `--header` and `--cookie` for its host.
- With `--pdfa` or `--factur-x`, a PDF input must be PDF/A itself, as its metadata declares: an invoice in Factur-X with its terms of sale in one file, `pdfkiln --factur-x invoice.xml invoice.html terms.pdf invoice.pdf`. PDFKiln checks the fonts of every page and takes the rest on the PDF's word. Refused: a PDF that is not PDF/A (export it as PDF/A-2b or 3b where it is made), a PDF/A for print, in CMYK (PDFKiln's PDF/A is in sRGB), PDF/A-4, and for a level of part 2, a PDF/A-3 with a file attached to its pages.
- Refused too: an encrypted PDF (PDFKiln does not remove a password or restrictions), a file that is not a PDF, a PDF on the standard input, and a PDF input for an image or with `--tagged`.

## Differences from wkhtmltopdf

- The page is rendered by Chromium, text is sharper. In the compatible mode, what templates tuned for wkhtmltopdf rely on is emulated, so that they keep their page count and page breaks (corpus below): the 0.8 shrinking, media queries seen through a 0 x 0 window, `@page` ignored, font sizes rounded to the pixel, the top margin dropped, table headers repeated, table rows moved whole to the next page rather than split, the margins computed from `--header-html`, no widow or orphan control by default, and the CSS that wkhtmltopdf's WebKit does not parse ignored (`display: flex` and `grid`, `calc()`, `var()`), so that the fallbacks written for it apply. Called as `pdfkiln`, the page gets current CSS without these emulations.
- The table of contents (`toc`) follows wkhtmltopdf's outline: same entries, page numbers and anchor names, its default style sheet byte for byte (`--dump-default-toc-xsl`). A style sheet given with `--xsl-style-sheet` runs on Chromium's XSLT 1.0, where wkhtmltopdf had XSLT 2.0.
- Links between objects become internal, as in wkhtmltopdf: to the element the fragment names, or dropped when there is none. Chromium writes the targets of internal links without the print scale and margins; PDFKiln puts them back where the page shows them.
- `wkhtmltoimage` is provided too: the same 63 options, Chromium's capture at the screen width (smart width included) and the height of the content; formats jpg, png, bmp, ppm, xpm, xbm and svg (the SVG embeds a PNG). Under a page whose body hides its overflow (Odoo reports), wkhtmltoimage added thousands of blank pixels; PDFKiln stops at the content.
- On Windows, wkhtmltopdf's Qt takes font metrics from GDI, rounded to whole pixels: lines of `line-height: normal` are mostly 1 to 2 px taller between 10 and 16 px, and the glyphs are drawn larger (Arial at 12 px drawn at 13.4 px; `node dist/bench/gdi.js`). PDFKiln renders the same page on every system, the one wkhtmltopdf gives on Linux.
- `--user-style-sheet` also takes an http or https URL, which wkhtmltopdf 0.12.6 ignores: its Qt WebKit only reads a local file or a `data:` URL.
- `--cookie` goes with the requests to the page's host only when the page is loaded from an http or https address, where wkhtmltopdf sends it to every site the page calls. A page given as a file or on the standard input has no host: there, as in wkhtmltopdf, it goes with every request.
- With `--proxy`, the proxy resolves the names of https addresses too, as Chromium has it, so `--proxy-hostname-lookup` has no effect: wkhtmltopdf resolves them itself unless it is given.
- Not provided: the C library `libwkhtmltox`.

## Known issues

- In a page opened from a file (a path, or standard input, which goes through a file as in wkhtmltopdf: what most libraries pass), an iframe of another origin is not printed: its space stays blank, without an error; wkhtmltopdf printed it. Chromium gives such an iframe a process of its own, and chrome-headless-shell does not print those. A page loaded from a URL prints its iframes, whatever their origin.
- In an image of the whole page (`pdfkiln page.html page.png`), an iframe of another origin below the window stays blank: Chromium paints such a frame only within the window. A window as high as the page (`--height`) paints it, but lays the page out in that window.

## Security

Called as `wkhtmltopdf`, the defaults of wkhtmltopdf are kept, it is the compatibility contract: a page reads no local file but itself unless `--enable-local-file-access` or `--allow <path>` says so (neither `..` nor a symbolic link gets around `--allow`), and loads whatever it wants from the network, from a server whose certificate does not verify too, with the warning "SSL error ignored". On top of them:

- `--kiln-block-private-network`: no loopback, private or link-local address (cloud metadata `169.254.169.254` included), checked after DNS resolution;
- `--kiln-block-invalid-certificates`: nothing from a server whose certificate does not verify (self-signed, expired, issued for another name);
- `--kiln-timeout <seconds>`: the conversion and Chromium are stopped after 120 s by default;
- Chromium's sandbox is on; `--kiln-no-sandbox` turns it off, not recommended.

Called as `pdfkiln`, the defaults are secure: a page reads no local file but itself unless `--enable-local-file-access` or `--allow <path>` says so, and reaches no loopback, private or link-local address, checked after DNS resolution, unless `--allow-private-network` is given. Nor does it load anything from a server whose certificate does not verify, unless `--allow-invalid-certificates` is given. `--header` and `--cookie` go with the requests to the input's host only: never to another site, nor with a request that another site sends to that host by a redirect, which that site chose; the input itself keeps them through its own redirects. An input that does not load, refused or in HTTP error, fails the conversion: exit 1, no PDF; with `--fail-on-resource-error`, so does a resource of the page. The conversion stops after 120 s (`--timeout`), and Chromium's sandbox is on (`--no-sandbox`, not recommended).

## Compatibility and speed

On the corpus of 32 real templates (Odoo 17, ERPNext 15, Sylius, pandoc; `corpus/README.md`), against the official wkhtmltopdf 0.12.6, in the development container (Ubuntu 24.04, `node dist/bench/compat.js`): the same page count on all 32, 99.1 % of the words on the same page.

A complete call on the two-page Odoo invoice of the corpus, median of the runs (`npm run bundle && node dist/bench/call.js --delay 200`, then without `--delay`: Odoo's own 1000 ms):

| | Delay | wkhtmltopdf 0.12.6 | PDFKiln (bundled command) | Difference |
| --- | --- | --- | --- | --- |
| Ubuntu 24.04, GitHub Actions | 200 ms | 0.59 s | 1.00 s | +0.41 s |
| Ubuntu 24.04, GitHub Actions | 1000 ms | 2.19 s | 1.00 s | −1.19 s |
| Windows Server 2025, GitHub Actions | 200 ms | 0.82 s | 1.66 s | +0.84 s |
| Windows Server 2025, GitHub Actions | 1000 ms | 2.41 s | 1.68 s | −0.73 s |
| Windows 11 PC, 20 threads | 200 ms | 1.21 s | 1.66 s | +0.45 s |
| Windows 11 PC, 20 threads | 1000 ms | 2.80 s | 1.56 s | −1.24 s |

CI run of 11 November 2026 (commit 5641518), 15 runs at 200 ms and 7 at 1000 ms; the Windows 11 rows, 9 runs; GitHub's runners vary by a few tenths of a second from one run to the next. wkhtmltopdf always waits the whole `--javascript-delay`; PDFKiln stops waiting as soon as nothing can change the page any more (no timer or animation frame pending, no request in flight, fonts loaded, the DOM still), which gives the same PDF sooner.

## Development

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

## Licenses

PDFKiln's code is under the [MIT license](LICENSE). It runs Chromium (BSD and third-party licenses), Node.js (MIT) and puppeteer-core (Apache-2.0), and prints Markdown with markdown-it (MIT), KaTeX and its fonts (MIT) and highlight.js (BSD-3-Clause); the packages ship each bundled package's license in `licenses/`.

The templates of the test corpus (`corpus/`) are not covered by the MIT license: each keeps its own (LGPL-3.0 for Odoo, GPL-3.0 for parts of ERPNext, MIT for Sylius...), noted in its `SOURCE.md` and `manifest.json`. So do the READMEs of the Markdown corpus (`bench/markdown/`). They are test data and are never part of the packages.
