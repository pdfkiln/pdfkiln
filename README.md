# PDFKiln

Drop-in replacement for wkhtmltopdf, powered by Chromium.

Site, documentation and migration guides: [pdfkiln.org](https://pdfkiln.org)

wkhtmltopdf is archived: its last release, 0.12.6, dates from June 2020, on a Qt WebKit that gets no security fixes. Yet pdfkit, knp-snappy, laravel-snappy, phpwkhtmltopdf, wicked_pdf, Rotativa, Odoo and ERPNext still call it. PDFKiln takes its place without a line of your code changing: the same command line, a current Chromium underneath.

- **Same command line**: the [122 options](docs/options.md) of wkhtmltopdf 0.12.6, its defaults, messages and exit codes.
- **Same pages**: on [32 real templates](docs/compatibility.md#compatibility-and-speed) (Odoo, ERPNext, Sylius, pandoc), the same page count as wkhtmltopdf on all 32, and 99.1 % of the words on the same page (Linux).
- **Tested by the libraries themselves**: the [own test suites](docs/compatibility.md#tested-by-the-libraries) of pdfkit, knp-snappy, laravel-snappy, phpwkhtmltopdf, wicked_pdf, CakePdf and go-wkhtmltopdf pass with PDFKiln in place of wkhtmltopdf.
- **Kept current**: each release ships the latest stable Chromium, sandboxed; on Debian and Ubuntu, `apt upgrade` brings it.

One program answers to two names:

```sh
wkhtmltopdf page.html page.pdf    # the command line of wkhtmltopdf 0.12.6, unchanged
pdfkiln page.html page.pdf        # its own, for what wkhtmltopdf never did
```

Called as `pdfkiln`, it renders current CSS, prints Markdown, writes PDF/A and Factur-X invoices, and is secure by default: see [Beyond wkhtmltopdf](#beyond-wkhtmltopdf).

PDFKiln is not affiliated with the original wkhtmltopdf project.

## Installation

Each package brings its Chromium; on Linux, the Debian package and the Docker image also bring the system libraries Chromium needs. The systems and details of each, and the SHA-256 sums and provenance attestations of the releases: [docs/install.md](docs/install.md).

### Debian and Ubuntu

From the signed APT repository, for amd64 and arm64: `apt upgrade` brings Chromium's security fixes. It installs `/usr/bin/wkhtmltopdf`, in the `PATH`, and replaces the official `wkhtmltox` package.

```sh
curl -fsS https://apt.pdfkiln.org/pdfkiln-archive-keyring.asc | sudo tee /usr/share/keyrings/pdfkiln-archive-keyring.asc > /dev/null
printf 'Types: deb\nURIs: https://apt.pdfkiln.org\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/pdfkiln-archive-keyring.asc\n' \
  | sudo tee /etc/apt/sources.list.d/pdfkiln.sources
sudo apt update && sudo apt install pdfkiln
```

### Windows

x64, and Windows Server with the Desktop Experience, not Server Core. The installer of the [latest release](https://github.com/pdfkiln/pdfkiln/releases/latest), which winget and Chocolatey run, installs in `C:\Program Files\wkhtmltopdf`, where pdfkit and most guides look: uninstall wkhtmltopdf first. The programs are not signed yet, so SmartScreen warns.

```sh
winget install pdfkiln
choco install pdfkiln
scoop bucket add pdfkiln https://github.com/pdfkiln/scoop
scoop install pdfkiln/pdfkiln
```

### macOS

ARM64, with Homebrew:

```sh
brew install pdfkiln/tap/pdfkiln
```

### Docker

amd64 and arm64. Docker's default seccomp profile stops Chromium's sandbox; [`docker/seccomp.json`](docker/seccomp.json) is that profile plus the namespaces the sandbox needs:

```sh
curl -fsSO https://raw.githubusercontent.com/pdfkiln/pdfkiln/main/docker/seccomp.json
docker run --rm -i --security-opt seccomp=seccomp.json ghcr.io/pdfkiln/pdfkiln wkhtmltopdf - - < page.html > page.pdf
```

### PHP

PHP 7.4 or later: `wkhtmltopdf` and `wkhtmltoimage` in `vendor/bin`, for knp-snappy and the other PHP libraries. On a Linux server, prefer the Debian package or Docker.

```sh
composer require pdfkiln/pdfkiln
```

### npm

Node.js 22.12 or later:

```sh
npx @pdfkiln/pdfkiln wkhtmltopdf page.html page.pdf
npm install -g @pdfkiln/pdfkiln    # pdfkiln, wkhtmltopdf and wkhtmltoimage
```

### GitHub Actions

For the tests of a project that calls wkhtmltopdf:

```yaml
- uses: pdfkiln/setup@v1
```

### Linux and macOS archives

Linux x64 and ARM64, macOS ARM64, from the [latest release](https://github.com/pdfkiln/pdfkiln/releases/latest): unpack anywhere and put the folder in the `PATH`. On Linux, add Chromium's system libraries; on Debian 13 and Ubuntu 24.04 and 26.04 (Debian 12 and Ubuntu 22.04: the same names without `t64`):

```sh
sudo apt install libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libdbus-1-3 libexpat1 libgbm1 \
  libglib2.0-0t64 libnspr4 libnss3 libudev1 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
  libxkbcommon0 libxrandr2 fontconfig fonts-liberation fonts-noto-color-emoji
```

Chromium's sandbox stays on: run PDFKiln as an unprivileged user, not root. On Ubuntu 23.10 and later, AppArmor restricts the user namespaces the sandbox needs; the Debian package loads a profile that allows them.

## Migrating from wkhtmltopdf

Point the library at PDFKiln's `wkhtmltopdf` or `wkhtmltoimage`, never at `pdfkiln`: called by that name, it switches to its own interface. A step-by-step guide for each library: [pdfkiln.org/migrate](https://pdfkiln.org/migrate/).

| Library | Setting |
| --- | --- |
| [knp-snappy](https://pdfkiln.org/migrate/knp-snappy/) | `new Knp\Snappy\Pdf('/usr/bin/wkhtmltopdf')`; with the Composer package, `new Knp\Snappy\Pdf(Pdfkiln\binary())` |
| [laravel-snappy](https://pdfkiln.org/migrate/laravel-snappy/) | `WKHTML_PDF_BINARY=/usr/bin/wkhtmltopdf` in `.env` (`config/snappy.php`, `pdf.binary`) |
| [phpwkhtmltopdf](https://pdfkiln.org/migrate/phpwkhtmltopdf/) | `new mikehaertl\wkhtmlto\Pdf(['binary' => '/usr/bin/wkhtmltopdf'])`, or nothing if it is in the `PATH` |
| [pdfkit](https://pdfkiln.org/migrate/pdfkit/) (Python) | `pdfkit.configuration(wkhtmltopdf='/usr/bin/wkhtmltopdf')`, or nothing if it is in the `PATH` |
| [wicked_pdf](https://pdfkiln.org/migrate/wicked-pdf/) | `WickedPdf.config = { exe_path: '/usr/bin/wkhtmltopdf' }` in an initializer; drop the `wkhtmltopdf-binary` gem |
| [imgkit](https://pdfkiln.org/migrate/imgkit/) (Python) | `imgkit.config(wkhtmltoimage='/usr/bin/wkhtmltoimage')`, or nothing if it is in the `PATH` |
| [Odoo](https://pdfkiln.org/migrate/odoo/), [Frappe / ERPNext](https://pdfkiln.org/migrate/frappe/) | nothing: they find `wkhtmltopdf` in the `PATH` |
| [Rotativa](https://pdfkiln.org/migrate/rotativa/) (ASP.NET) | copy the content of `wkhtmltopdf\bin` (the programs and `chromium\`) into the Rotativa folder |

Libraries that read the version keep working: `wkhtmltopdf --version` prints `wkhtmltopdf 0.12.6 (with patched qt), pdfkiln <version>, Chromium <version>`.

## Beyond wkhtmltopdf

Called as `pdfkiln`, PDFKiln does what wkhtmltopdf never did. The page gets current CSS in print media, without the emulations of the compatible mode, and its paper size, margins, headers and footers come from its CSS (`@page` and its margin boxes).

```sh
pdfkiln invoice.html invoice.pdf                          # paper, margins, headers from @page
pdfkiln README.md README.pdf                              # Markdown, as GitHub writes it
pdfkiln --pdfa report.html report.pdf                     # PDF/A, for archiving
pdfkiln --factur-x invoice.xml invoice.html invoice.pdf   # a Factur-X or ZUGFeRD invoice
pdfkiln --tagged --outline guide.html guide.pdf           # for screen readers, with bookmarks
pdfkiln --wait-for "#chart" dashboard.html dashboard.pdf  # once the page has added #chart
```

- **Markdown** in GitHub's dialect (tables, task lists, alerts, footnotes, emoji, raw HTML), math and coloured code included, laid out for paper; its front matter gives the title, author and language.
- **PDF/A** at level 2b, 2u, 3b or 3u, refused rather than labelled when the page cannot conform. **Factur-X and ZUGFeRD**: the invoice's XML, from the invoicing software, attached to a PDF/A-3: the page a person reads and the data a program reads, in one file.
- **Secure by default**: no local file but the page itself, no private address, nothing from a server whose certificate does not verify, unless an option allows it; `--header` and `--cookie` go to the input's host only.

Libraries call `wkhtmltopdf`, which keeps the options of wkhtmltopdf 0.12.6 and adds none: these are reached by calling `pdfkiln`. `pdfkiln --help` lists them all, and [docs/native.md](docs/native.md) gives their rules. This interface is young: unlike the wkhtmltopdf command line, it may change in a minor version, and the version's notes (`CHANGELOG.md`) say so first.

## Differences from wkhtmltopdf

Chromium renders the page, and text is sharper. The compatible mode emulates what templates tuned for wkhtmltopdf rely on (the 0.8 shrinking, `@page` ignored, flex and grid ignored...), so that they keep their page breaks. Otherwise:

- `--xsl-style-sheet` runs on XSLT 1.0, where wkhtmltopdf had XSLT 2.0;
- `--cookie` goes to the page's host only when the page comes from an http or https address, where wkhtmltopdf sends it to every site;
- `--user-style-sheet` also takes a URL, and `--proxy-hostname-lookup` has no effect;
- on Windows, a page renders as wkhtmltopdf renders it on Linux, without the taller lines and larger glyphs of GDI;
- `wkhtmltoimage` stops at the content, without the blank pixels wkhtmltopdf added under Odoo reports;
- not provided: the C library `libwkhtmltox`.

Each in detail: [docs/compatibility.md](docs/compatibility.md#differences-from-wkhtmltopdf).

## Known issues

- In a page opened from a file (a path, or the standard input, what most libraries pass), an iframe of another origin is not printed, where wkhtmltopdf printed it; a page loaded from a URL prints it ([why](docs/compatibility.md#known-issues)).

## Security

Called as `wkhtmltopdf`, PDFKiln keeps the defaults of wkhtmltopdf, the compatibility contract: a page reads no local file but itself unless allowed, and loads anything from the network, certificate errors ignored. On top of them:

- `--kiln-block-private-network`: no loopback, private or link-local address (cloud metadata `169.254.169.254` included), checked after DNS resolution;
- `--kiln-block-invalid-certificates`: nothing from a server whose certificate does not verify;
- `--kiln-timeout <seconds>`: the conversion and Chromium are stopped after 120 s by default;
- Chromium's sandbox is on; `--kiln-no-sandbox` turns it off, not recommended.

Called as `pdfkiln`, all four are the defaults ([docs/native.md](docs/native.md#security)). To report a vulnerability: [SECURITY.md](SECURITY.md).

## Speed

A complete call on the two-page Odoo invoice of the corpus, median, Ubuntu 24.04 on GitHub Actions:

| Delay | wkhtmltopdf 0.12.6 | PDFKiln |
| --- | --- | --- |
| 200 ms | 0.59 s | 1.00 s |
| 1000 ms, Odoo's | 2.19 s | 1.00 s |

wkhtmltopdf always waits the whole `--javascript-delay`; PDFKiln stops as soon as nothing can change the page any more. Windows, and how to measure: [docs/compatibility.md](docs/compatibility.md#compatibility-and-speed).

## Development

Node.js 22.12 or later:

```sh
npm ci && npm run build && npm run fetch:chromium
npm test    # PyMuPDF for the text checks
```

The packages, the benches and the libraries' own test suites: [docs/development.md](docs/development.md).

## Licenses

PDFKiln's code is under the [MIT license](LICENSE). It runs Chromium (BSD and third-party licenses), Node.js (MIT) and puppeteer-core (Apache-2.0), and prints Markdown with markdown-it (MIT), KaTeX and its fonts (MIT) and highlight.js (BSD-3-Clause); the packages ship each bundled package's license in `licenses/`.

The templates of the test corpus (`corpus/`) are not covered by the MIT license: each keeps its own (LGPL-3.0 for Odoo, GPL-3.0 for parts of ERPNext, MIT for Sylius...), noted in its `SOURCE.md` and `manifest.json`. So do the READMEs of the Markdown corpus (`bench/markdown/`). They are test data and are never part of the packages.
