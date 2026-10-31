# PDFKiln

Drop-in replacement for wkhtmltopdf, powered by Chromium.

Site, documentation and migration guides: [pdfkiln.org](https://pdfkiln.org)

wkhtmltopdf is archived: its last release, 0.12.6, dates from June 2020, on a Qt WebKit that gets no security fixes. Yet pdfkit, knp-snappy, laravel-snappy, phpwkhtmltopdf, wicked_pdf, Rotativa, Odoo and ERPNext still call it. PDFKiln takes its place without a line of your code changing: the same command line, a current Chromium underneath.

- **Same command line**: the 122 options of wkhtmltopdf 0.12.6, its defaults, messages and exit codes.
- **Same pages**: on 32 real templates (Odoo, ERPNext, Sylius, pandoc), the same page count as wkhtmltopdf on all 32, and 99.1 % of the words on the same page (Linux).
- **Tested by the libraries themselves**: the own test suites of pdfkit, knp-snappy, phpwkhtmltopdf and wicked_pdf pass with PDFKiln in place of wkhtmltopdf.
- **Kept current**: each release ships the latest stable Chromium, sandboxed; on Debian and Ubuntu, `apt upgrade` brings it.

PDFKiln is one program that answers to two names:

- called as `wkhtmltopdf` (or `pdfkiln wkhtmltopdf ...`), it accepts the command line of wkhtmltopdf 0.12.6, so existing integrations keep working unchanged;
- called as `pdfkiln`, it offers its own interface, with modern print defaults: print media, paper size, margins, headers and footers from the page's CSS (`@page` and its margin boxes). A few options give what the page cannot say itself: a style sheet of your own (`--css`), its screen rules (`--media screen`), the request's headers and cookies (`--header`, `--cookie`), an element to wait for (`--wait-for`); `pdfkiln --help` lists them all. This interface is young: unlike the wkhtmltopdf command line, it may change in a minor version, as in 1.1.0, and the version's notes (`CHANGELOG.md`) say so first.

PDFKiln is not affiliated with the original wkhtmltopdf project.

## Installation

**Debian and Ubuntu** (built for Debian 12 and 13 and Ubuntu 22.04 and later, tested on Ubuntu 24.04 and 26.04 and Debian 13; amd64 and arm64), from the signed APT repository, which brings Chromium's security fixes with `apt upgrade`:

```sh
curl -fsS https://apt.pdfkiln.org/pdfkiln-archive-keyring.asc | sudo tee /usr/share/keyrings/pdfkiln-archive-keyring.asc > /dev/null
printf 'Types: deb\nURIs: https://apt.pdfkiln.org\nSuites: stable\nComponents: main\nSigned-By: /usr/share/keyrings/pdfkiln-archive-keyring.asc\n' \
  | sudo tee /etc/apt/sources.list.d/pdfkiln.sources
sudo apt update && sudo apt install pdfkiln
```

It installs `/usr/bin/pdfkiln` and `/usr/bin/wkhtmltopdf`, replaces the official `wkhtmltox` package, and loads an AppArmor profile so that Chromium's sandbox works on Ubuntu 24.04 and later. The `.deb` of a [release](https://github.com/Jamalofski/pdfkiln/releases/latest), installed by hand, sets the repository up itself.

**Windows** (x64; ARM runs it in emulation; Windows Server with the Desktop Experience, IIS included, not Server Core, where Chromium stops at start and PDFKiln says so): from the [latest release](https://github.com/Jamalofski/pdfkiln/releases/latest), the installer `pdfkiln-<version>-windows-x64-setup.exe`, or the zip, which holds `wkhtmltopdf\bin\wkhtmltopdf.exe` as the old installer did. Both install in `C:\Program Files\wkhtmltopdf`, the path pdfkit and most guides use: uninstall wkhtmltopdf first. The programs are not signed yet: SmartScreen warns about the installer; check it against the release's `SHA256SUMS`.

**Linux and macOS archives** (Linux x64 and ARM64, macOS ARM64): the program, its Chromium, and `wkhtmltopdf` and `wkhtmltoimage` beside it. Unpack anywhere and put the folder in the `PATH`. On Linux, Chromium needs system libraries the archive does not hold, the ones the Debian package depends on; PDFKiln names those missing when Chromium cannot start. On Debian 13 and Ubuntu 24.04 and 26.04 (on Debian 12 and Ubuntu 22.04, the same names without `t64`):

```sh
sudo apt install libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libdbus-1-3 libexpat1 libgbm1 \
  libglib2.0-0t64 libnspr4 libnss3 libudev1 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
  libxkbcommon0 libxrandr2 fontconfig fonts-liberation
```

**Docker** (amd64 and arm64), on Debian 13 slim, as an unprivileged user. Docker's default seccomp profile stops Chromium's sandbox; [`docker/seccomp.json`](docker/seccomp.json) is that profile plus the namespaces the sandbox needs:

```sh
curl -fsSO https://raw.githubusercontent.com/Jamalofski/pdfkiln/main/docker/seccomp.json
docker run --rm -i --security-opt seccomp=seccomp.json ghcr.io/jamalofski/pdfkiln wkhtmltopdf - - < page.html > page.pdf
```

`--security-opt seccomp=unconfined` and `--cap-add SYS_ADMIN` work too, but drop the whole filter or grant a capability that helps escape a container: not recommended.

**PHP** (Composer, PHP 7.4 or later), for knp-snappy and the other PHP libraries: [`pdfkiln/pdfkiln`](https://packagist.org/packages/pdfkiln/pdfkiln) puts `wkhtmltopdf` and `wkhtmltoimage` in `vendor/bin` and downloads the program of the platform on first use, its SHA-256 checked. It takes the place of packages that ship wkhtmltopdf itself, such as `h4cc/wkhtmltopdf-amd64`. On a Linux server, the Debian package or the Docker image is better: they bring Chromium's system libraries.

```sh
composer require pdfkiln/pdfkiln
```

```php
$snappy = new Knp\Snappy\Pdf(Pdfkiln\binary());
```

**npm** (Node.js 22.12 or later), for Node projects; Chromium is downloaded on first use into the user's cache, its SHA-256 checked. npm refuses the name `pdfkiln`, too close to `pdfkit`, hence the scope:

```sh
npx @pdfkiln/pdfkiln wkhtmltopdf page.html page.pdf
npm install -g @pdfkiln/pdfkiln    # pdfkiln, wkhtmltopdf and wkhtmltoimage
```

**Scoop** (Windows), the zip with its programs on the `PATH`:

```sh
scoop bucket add pdfkiln https://github.com/pdfkiln/scoop
scoop install pdfkiln/pdfkiln
```

**Homebrew** (macOS ARM64):

```sh
brew install pdfkiln/tap/pdfkiln
```

**winget**: submitted to winget-pkgs, under review; once accepted, `winget install pdfkiln`.

Chromium's sandbox stays on: run as an unprivileged user, not root.

## Status

The compatible mode is implemented: the 122 options of wkhtmltopdf 0.12.6 are accepted ([docs/options.md](docs/options.md): 98 implemented, 24 accepted without effect), pages, covers, the table of contents, text and HTML headers and footers with their variables, outlines, links between objects, copies, the network rules of wkhtmltopdf (local file access, `--allow`, cookies, custom headers, authentication, `--post`, client certificates) and its layout quirks, emulated. Our own options start with `--kiln-`: `--kiln-timeout`, `--kiln-block-private-network`, `--kiln-no-sandbox`.

The own test suites of pdfkit 1.0.0, knp-snappy 1.7.3, phpwkhtmltopdf 2.5.0 and wicked_pdf 2.7.0 pass with PDFKiln in place of wkhtmltopdf (`test/libraries/run.sh`, CI job `libraries`). imgkit 1.2.3's suite, run on wkhtmltoimage, passes 43 of 43 tests in the development container, as with wkhtmltoimage 0.12.6 (without its tests of xvfb, and of github.com, which the container cannot reach); the CI job runs it too.

Each release is built and tested by CI, then published by hand from two green runs (`.github/workflows/release.yml`, `apt.yml`, `npm.yml`, `docker.yml`), with SHA-256 sums and build provenance attestations (`gh attestation verify <file> --repo Jamalofski/pdfkiln`).

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

## Differences from wkhtmltopdf

- The page is rendered by Chromium, text is sharper. In the compatible mode, what templates tuned for wkhtmltopdf rely on is emulated, so that they keep their page count and page breaks (corpus below): the 0.8 shrinking, media queries seen through a 0 x 0 window, `@page` ignored, font sizes rounded to the pixel, the top margin dropped, table headers repeated, table rows moved whole to the next page rather than split, the margins computed from `--header-html`, no widow or orphan control by default, and the CSS that wkhtmltopdf's WebKit does not parse ignored (`display: flex` and `grid`, `calc()`, `var()`), so that the fallbacks written for it apply. Called as `pdfkiln`, the page gets current CSS without these emulations.
- The table of contents (`toc`) follows wkhtmltopdf's outline: same entries, page numbers and anchor names, its default style sheet byte for byte (`--dump-default-toc-xsl`). A style sheet given with `--xsl-style-sheet` runs on Chromium's XSLT 1.0, where wkhtmltopdf had XSLT 2.0.
- Links between objects become internal, as in wkhtmltopdf: to the element the fragment names, or dropped when there is none. Chromium writes the targets of internal links without the print scale and margins; PDFKiln puts them back where the page shows them.
- `wkhtmltoimage` is provided too: the same 63 options, Chromium's capture at the screen width (smart width included) and the height of the content; formats jpg, png, bmp, ppm, xpm, xbm and svg (the SVG embeds a PNG). Under a page whose body hides its overflow (Odoo reports), wkhtmltoimage added thousands of blank pixels; PDFKiln stops at the content.
- `pdfkiln serve` keeps Chromium open: `wkhtmltopdf` and `wkhtmltoimage` connect to it by themselves (a socket only the same user can open, never a TCP port), each conversion in a browser context of its own. It saves Chromium's start-up and shutdown only, on the two-page Odoo invoice: 0.17 s on Ubuntu, 0.44 s on Windows Server 2025, 0.06 s on macOS (GitHub Actions), 0.31 s on a Windows 11 PC (`node dist/bench/call.js --server --delay 200`). The Debian package has a `pdfkiln@.service` unit, not enabled: `systemctl enable --now pdfkiln@odoo`.
- On Windows, wkhtmltopdf's Qt takes font metrics from GDI, rounded to whole pixels: lines of `line-height: normal` are mostly 1 to 2 px taller between 10 and 16 px, and the glyphs are drawn larger (Arial at 12 px drawn at 13.4 px; `node dist/bench/gdi.js`). PDFKiln renders the same page on every system, the one wkhtmltopdf gives on Linux.
- Not provided: the C library `libwkhtmltox`.

## Known issues in 1.0

- In a page opened from a file (a path, or standard input, which goes through a file as in wkhtmltopdf: what most libraries pass), an iframe of another origin is not printed: its space stays blank, without an error; wkhtmltopdf printed it. Chromium gives such an iframe a process of its own, and chrome-headless-shell does not print those. A page loaded from a URL prints its iframes, whatever their origin.

## Security

Called as `wkhtmltopdf`, the defaults of wkhtmltopdf are kept, it is the compatibility contract: a page reads no local file but itself unless `--enable-local-file-access` or `--allow <path>` says so (neither `..` nor a symbolic link gets around `--allow`), and loads whatever it wants from the network. On top of them:

- `--kiln-block-private-network`: no loopback, private or link-local address (cloud metadata `169.254.169.254` included), checked after DNS resolution;
- `--kiln-timeout <seconds>`: the conversion and Chromium are stopped after 120 s by default;
- Chromium's sandbox is on; `--kiln-no-sandbox` turns it off, not recommended.

Called as `pdfkiln`, the defaults are secure: a page reads no local file but itself unless `--enable-local-file-access` or `--allow <path>` says so, and reaches no loopback, private or link-local address, checked after DNS resolution, unless `--allow-private-network` is given. `--header` and `--cookie` go with the requests to the input's host only, never to another site. An input that does not load, refused or in HTTP error, fails the conversion: exit 1, no PDF. The conversion stops after 120 s (`--timeout`), and Chromium's sandbox is on (`--no-sandbox`, not recommended).

## Compatibility and speed

On the corpus of 32 real templates (Odoo 17, ERPNext 15, Sylius, pandoc; `corpus/README.md`), against the official wkhtmltopdf 0.12.6, in the development container (Ubuntu 24.04, `node dist/bench/compat.js`): the same page count on all 32, 99.1 % of the words on the same page.

A complete call on the two-page Odoo invoice of the corpus, median of the runs (`npm run bundle && node dist/bench/call.js --delay 200`, then without `--delay`: Odoo's own 1000 ms):

| | Delay | wkhtmltopdf 0.12.6 | PDFKiln (bundled command) | Difference |
| --- | --- | --- | --- | --- |
| Ubuntu 24.04, GitHub Actions | 200 ms | 0.52 s | 1.11 s | +0.59 s |
| Ubuntu 24.04, GitHub Actions | 1000 ms | 2.13 s | 1.14 s | −0.99 s |
| Ubuntu 24.04, development container | 200 ms | 0.58 s | 0.84 s | +0.26 s |
| Windows Server 2025, GitHub Actions | 200 ms | 0.69 s | 2.15 s | +1.46 s |
| Windows Server 2025, GitHub Actions | 1000 ms | 2.30 s | 2.12 s | −0.18 s |
| Windows 11 PC, 20 threads | 200 ms | 1.36 s | 1.80 s | +0.44 s |
| Windows 11 PC, 20 threads | 1000 ms | 2.91 s | 1.85 s | −1.06 s |

CI run of 24 October 2026 (commit 6ec9c08), 15 runs at 200 ms and 7 at 1000 ms; the Windows 11 rows, 9 runs, after Chromium's close on Windows lost a needless `taskkill` (0.85 s on that PC, 0.1 s on GitHub's); GitHub's runners vary by a few tenths of a second from one run to the next. wkhtmltopdf always waits the whole `--javascript-delay`; PDFKiln stops waiting as soon as nothing can change the page any more (no timer or animation frame pending, no request in flight, fonts loaded, the DOM still), which gives the same PDF sooner.

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
test/libraries/run.sh /tmp/libs        # the libraries' own test suites
```

## Licenses

PDFKiln's code is under the [MIT license](LICENSE). It runs Chromium (BSD and third-party licenses), Node.js (MIT) and puppeteer-core (Apache-2.0).

The templates of the test corpus (`corpus/`) are not covered by the MIT license: each keeps its own (LGPL-3.0 for Odoo, GPL-3.0 for parts of ERPNext, MIT for Sylius...), noted in its `SOURCE.md` and `manifest.json`. They are test data and are never part of the packages.
