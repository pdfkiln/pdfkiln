# The compatible mode

Called as `wkhtmltopdf` (or `pdfkiln wkhtmltopdf ...`), PDFKiln accepts the command line of wkhtmltopdf 0.12.6, so existing integrations keep working unchanged. Its options, one by one: [options.md](options.md). Pointing a library at it: the [README](../README.md#migrating-from-wkhtmltopdf), and a guide for each library on [pdfkiln.org/migrate](https://pdfkiln.org/migrate/).

## What is implemented

The compatible mode is implemented: the 122 options of wkhtmltopdf 0.12.6 are accepted ([options.md](options.md): 101 implemented, 21 accepted without effect), pages, covers, the table of contents, text and HTML headers and footers with their variables, outlines, links between objects, copies, the network rules of wkhtmltopdf (local file access, `--allow`, cookies, custom headers, authentication, `--post`, client certificates, certificate errors ignored) and its layout quirks, emulated. Our own options start with `--kiln-`: `--kiln-timeout`, `--kiln-block-private-network`, `--kiln-block-invalid-certificates`, `--kiln-no-sandbox`.

## Tested by the libraries

The own test suites of pdfkit 1.0.0, knp-snappy 1.7.3, laravel-snappy 1.0.5, phpwkhtmltopdf 2.5.0, wicked_pdf 2.7.0, CakePdf 5.3.0 and go-wkhtmltopdf 1.9.3 pass with PDFKiln in place of wkhtmltopdf (`test/libraries/run.sh`, CI job `libraries`).

- go-wkhtmltopdf's with local images in place of those its test pages load from loremflickr.com, which answered 500 on 31 October 2026, and without its example that converts a page of pkg.go.dev, whose badge from codebeat.co no longer loads: wkhtmltopdf 0.12.6 fails on both, as PDFKiln does.
- knp-snappy's and CakePdf's suites only build command lines: a script for each also drives the program for real (`snappy-smoke.php`, `cakepdf-smoke.php`).
- KnpSnappyBundle 1.10.6's tests only check its configuration: with its binaries set to PDFKiln's, its services and responses return a PDF and a JPEG (`snappy-bundle-smoke.php`).
- imgkit 1.2.3's suite, run on wkhtmltoimage, passes 43 of 43 tests in the development container, as with wkhtmltoimage 0.12.6 (without its tests of xvfb, and of github.com, which the container cannot reach); the CI job runs it too.
- Rotativa is tested with Rotativa.AspNetCore's driver, and in IIS as the application pool's identity on Windows Server with the Desktop Experience (not on Server Core, see [Installation](install.md)).

## Differences from wkhtmltopdf

- The page is rendered by Chromium, text is sharper. In the compatible mode, what templates tuned for wkhtmltopdf rely on is emulated, so that they keep their page count and page breaks (corpus below): the 0.8 shrinking, media queries seen through a 0 x 0 window, `@page` ignored, wkhtmltopdf's fonts for text without a family and for `serif`, `sans-serif` or `monospace`, font sizes rounded to the pixel and characters at their font's own width, the top margin dropped, table headers repeated, table rows moved whole to the next page rather than split, the margins computed from `--header-html`, no widow or orphan control by default, and the CSS that wkhtmltopdf's WebKit does not parse ignored (`display: flex` and `grid`, `calc()`, `var()`), so that the fallbacks written for it apply, and `system-ui` taken as it takes it, the name of a family that no font has. Called as `pdfkiln`, the page gets current CSS without these emulations.
- The table of contents (`toc`) follows wkhtmltopdf's outline: same entries, page numbers and anchor names, its default style sheet byte for byte (`--dump-default-toc-xsl`). A style sheet given with `--xsl-style-sheet` runs on Chromium's XSLT 1.0, where wkhtmltopdf had XSLT 2.0.
- Links between objects become internal, as in wkhtmltopdf: to the element the fragment names, or dropped when there is none. Chromium writes the targets of internal links without the print scale and margins; PDFKiln puts them back where the page shows them.
- `wkhtmltoimage` is provided too: the same 63 options, Chromium's capture at the screen width (smart width included) and the height of the content; formats jpg, png, bmp, ppm, xpm, xbm and svg (the SVG embeds a PNG). Under a page whose body hides its overflow (Odoo reports), wkhtmltoimage added thousands of blank pixels; PDFKiln stops at the content.
- On Windows, wkhtmltopdf's Qt takes font metrics from GDI, rounded to whole pixels: lines of `line-height: normal` are mostly 1 to 2 px taller between 10 and 16 px, and the glyphs are drawn larger (Arial at 12 px drawn at 13.4 px; `node dist/bench/gdi.js`). PDFKiln renders the same page on every system, the one wkhtmltopdf gives on Linux.
- `--user-style-sheet` also takes an http or https URL, which wkhtmltopdf 0.12.6 ignores: its Qt WebKit only reads a local file or a `data:` URL.
- `--cookie` goes with the requests to the page's host only when the page is loaded from an http or https address, where wkhtmltopdf sends it to every site the page calls. A page given as a file or on the standard input has no host: there, as in wkhtmltopdf, it goes with every request.
- `--debug-javascript` gives each message the line it comes from, where wkhtmltopdf 0.12.6 gave 1, and tells an error in Chromium's words (`ReferenceError: f is not defined`, where wkhtmltopdf wrote `Can't find variable: f`).
- With `--proxy`, the proxy resolves the names of https addresses too, as Chromium has it, so `--proxy-hostname-lookup` has no effect: wkhtmltopdf resolves them itself unless it is given.
- In a page opened from a file (a path, or standard input, which goes through a file as in wkhtmltopdf: what most libraries pass), an iframe of another origin runs in a process of its own, which chrome-headless-shell prints blank. PDFKiln loads it again on its own, at its size and under the page's rules, prints it, and draws it where it stands, its links with it; wkhtmltopdf printed it in the page. So is a `--header-html` or `--footer-html` page given by its address, which PDFKiln lays in a page opened from a file. A frame whose content depends on the page that holds it (messages between the two) may come out otherwise, and some stay blank ([Frames of another origin](native.md#frames-of-another-origin)). A page loaded from a URL prints its iframes itself, whatever their origin.
- Not provided: the C library `libwkhtmltox`.

## Security

Called as `wkhtmltopdf`, the defaults of wkhtmltopdf are kept, it is the compatibility contract: a page reads no local file but itself unless `--enable-local-file-access` or `--allow <path>` says so (neither `..` nor a symbolic link gets around `--allow`), and loads whatever it wants from the network, from a server whose certificate does not verify too, with the warning "SSL error ignored". On top of them:

- `--kiln-block-private-network`: no loopback, private or link-local address (cloud metadata `169.254.169.254` included), checked after DNS resolution;
- `--kiln-block-invalid-certificates`: nothing from a server whose certificate does not verify (self-signed, expired, issued for another name);
- `--kiln-timeout <seconds>`: the conversion and Chromium are stopped after 120 s by default;
- Chromium's sandbox is on; `--kiln-no-sandbox` turns it off, not recommended.

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
