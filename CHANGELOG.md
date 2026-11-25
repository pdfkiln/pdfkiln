# Changes

What each version changes, for those who use it. A version's release notes
open with its section here (scripts/release.ts): no release without one.
A version that changes Chromium says so under Security: the two versions,
and a link to Google's release notes. Up to 1.0.2, see each version's
GitHub release.

## 1.5.1

Bugs fixed:

- **php-fpm from packages.sury.org or the ondrej/php PPA** keeps Chromium from its sandbox: PDFKiln now names the unit and the two lines that allow it.

## 1.5.0

Called as `pdfkiln`, two changes to the layout of a PDF:

- **The page's paper**: a page is laid out for the paper set by its `@page` rules or by `--css` (`@page { size: A4 landscape }`), which its media queries and its scripts now see. Up to 1.4.0, a page that asked for A4 landscape, Letter or A3 was printed on that paper but laid out for A4 portrait, as in a window 718 pixels wide; on landscape A4, it now gets 1047 pixels, the width it is printed at. A page whose layout depends on its width may change: Bootstrap 4's print style sheet, which asks for A3, now prints in its wide layout rather than its phone layout. A page on a paper other than A4 portrait is printed twice, in a fraction of a second more; one on A4 portrait, and a document whose pages differ in size, print as before.
- **`--scale` for a PDF**: the scale of the print, from 0.1 to 2, as in a browser's print dialog. The paper keeps its size and its margins, and holds a page as much wider: a page made for screens prints as a wide window shows it, not in the layout it keeps for narrow windows. On A4, `--scale 0.56` prints what a window 1280 pixels wide shows. Up to 1.4.0, `--scale` was for images only.

```sh
pdfkiln --scale 0.56 https://example.com page.pdf
```

Bugs fixed:

- **Composer package under php-fpm**: on Debian and Ubuntu, the first PDF failed with `pdfkiln: cannot create /var/www/.cache/pdfkiln/dist`, as php-fpm gives PHP the home folder of the pool's user, `/var/www` for `www-data`, which root owns. An account that cannot write in its home folder now keeps the program in `/var/tmp/pdfkiln-<uid>`, which stays on disk across reboots. So does an account without `HOME`, as under Apache's mod_php, which got `/tmp/pdfkiln-<uid>` up to 1.4.0: Debian 13 keeps `/tmp` in memory, and the program took 393 MB of it. Run at deployment from the project's folder, `sudo -u www-data vendor/bin/wkhtmltopdf --version` downloads the program where php-fpm looks for it, and says where. The package's README shows how to give it a folder of its own, which mod_php needs: Apache empties its temporary folders at each restart.
- **Run as root**, as in many containers, CI jobs and `drush` calls, PDFKiln said only `Chromium did not start: Protocol error (Target.setDiscoverTargets): Target closed`. It now says that Chromium refuses to run as root with its sandbox on, and to run PDFKiln as an unprivileged user; the sandbox stays on.
- **AppArmor**, on Ubuntu 23.10 and later, keeps the Chromium of the archive and of the npm and Composer packages from its sandbox until a profile allows it: PDFKiln now says so, with the path the profile must name. The Debian package loads its own profile.

Called as `pdfkiln`, bugs fixed:

- **`--css` on a page whose Content-Security-Policy refuses inline styles**, as many sites do, had no effect. It applies there too, without its `@import` rules; the policy stays in force for the page.
- **The messages of a sandbox that cannot start** name `--no-sandbox`, where they named `--kiln-no-sandbox`, which `pdfkiln` refuses.

Called as `wkhtmltopdf`, now as in wkhtmltopdf 0.12.6:

- **`--user-style-sheet`**, given as a file or a `data:` URL, is a user style sheet: the page's rules outrank it whatever their specificity, and its `!important` declarations outrank the page's. Up to 1.4.0, a rule of it more specific than the page's won, and the page's `!important` won over its own.
- **Pages whose Content-Security-Policy refuses inline styles**, which wkhtmltopdf's WebKit does not know: `--user-style-sheet` applies there too, but without its `@import` rules. Their page breaks fall as in wkhtmltopdf: a table row that does not fit moves whole to the next page, and a paragraph may leave a single line at the bottom or the top of a page. Up to 1.4.0, the user style sheet had no effect there, and Chromium split such rows and kept at least two lines of a paragraph together.

## 1.4.0

Called as `pdfkiln`, three new features:

- **Images**: `pdfkiln page.html page.png` captures the page in PNG, WebP or JPEG, for the preview of a shared link, a thumbnail or a picture in an email: the whole page, in screen media, in a window 1280 pixels wide; with `--height`, the window alone; with `--element`, one element. `--scale`, `--quality` and `--transparent` set the rest, and the other options work as for a PDF. An output named `.png`, `.webp`, `.jpg` or `.jpeg`, which got a PDF, now gets an image.
- **PDF inputs**: a PDF made elsewhere, a file or an http or https URL named `.pdf`, goes among the inputs, its pages as they are: `pdfkiln invoice.html terms.pdf invoice.pdf` puts the terms of sale after the invoice. Its links to its own pages keep working, and `--outline` keeps its bookmarks; PDFs alone are merged without Chromium. With `--pdfa` or `--factur-x`, a PDF input must be PDF/A itself, so that an invoice and its terms of sale make one Factur-X file. An encrypted PDF is refused, and so is a PDF input with `--tagged` or for an image.
- **Passwords**: `--user-password` encrypts the PDF with AES-256, to be opened with that password; `--owner-password` with `--no-print`, `--no-copy` or `--no-modify` restricts what the others may do with it, screen readers still reading it. PDF/A forbids encryption: `--pdfa` and `--factur-x` take none.

```sh
pdfkiln https://example.com page.png
pdfkiln --width 1200 --height 630 card.html card.webp
pdfkiln --factur-x invoice.xml invoice.html terms.pdf invoice.pdf
pdfkiln --user-password "$PASSWORD" payslip.html payslip.pdf
```

Called as `wkhtmltopdf`, `--debug-javascript`, accepted without effect up to 1.3.0, prints what the page's scripts write to the console, and their errors, as warnings with their address and line, as wkhtmltopdf 0.12.6 does.

Among the fixes, two that libraries meet: Odoo 15 and later print their reports with their style and header on a server with several databases, and a page given as a file prints its frames of another site, both as with wkhtmltopdf.

Security:

- Chromium 158.0.8127.36 → 158.0.8127.88 ([release notes](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop_01734282054.html)).

Security, called as `pdfkiln`:

- **Redirects from another site**: a request that another site sends to the input's host by a redirect, for an image, a style sheet, a script, a frame or a font, no longer takes `--header` and `--cookie` there, since that site chose it. Up to 1.3.0, all but the fonts took them. Only the input's own request keeps them through its redirects, such as a login on another site; a page it opens next, by a meta refresh or a script, does not.
- **Referer**: a request redirected to another site sends there the Referer that Chromium's policy gives it, often the page's origin alone. Up to 1.3.0, with `--header`, it sent the page's whole address, its query included.

Security, called as `wkhtmltopdf`:

- **`--custom-header` and `--post` with a page given as a file**: without `--custom-header-propagation`, the header, and the form of `--post`, went with the request of the page's first frame, to that frame's host, as if it were the page's own. They go with the page's own request only, as in wkhtmltopdf 0.12.6, and so nowhere from a file.

Bugs fixed:

- **Frames of another site in a page given as a file** (a path, or the standard input, what most libraries pass) are printed where they stand, their links with them, as wkhtmltopdf printed them. Up to 1.3.0, their place stayed blank, without an error: Chromium prints such a frame blank. PDFKiln loads each again on its own, under the rules of the page, and draws it in; a frame whose content depends on the page that holds it may come out otherwise.
- **Frames that wait to be scrolled to**: a page with an iframe `loading="lazy"`, too far below the window to load, no longer makes the conversion 30 s longer called as `pdfkiln`, 60 s as `wkhtmltopdf`.
- **Windows installer**: an update removes what the version before installed and the new one no longer has, among Chromium's files and the licenses of the bundled packages; up to 1.3.0, it stayed in `C:\Program Files\wkhtmltopdf`. The uninstall removes Chromium's folder whole, with the `debug.log` Chromium wrote there up to 1.3.0.
- **Chromium's log on Windows**: Chromium no longer writes a `debug.log` beside itself, in the folder of the package or of the user's cache, where each conversion added its warnings, such as a certificate that does not verify. Its network service, which wrote them, runs in its main process, whose log goes with the conversion's temporary folder.
- **Composer and npm packages, a program gone from the cache**: when a version's folder in the user's cache has lost its program, to an antivirus, a cleaner of temporary files or a hand, the next call installs that version again. Up to 1.3.0, every call downloaded the whole archive again and kept the broken folder: the Composer package then returned the path of a program that was not there, and the npm package failed.
- **Composer and npm packages, a download cut short** says so, with how much of the archive arrived: `the download of … stopped at 75 of 150 MB: run it again`. Up to 1.3.0, it was reported as an archive that did not match its SHA-256.
- **Composer package, errors on first use**: a cache folder where the archive cannot be written, an archive that cannot be read and a `tar` that cannot run give a `pdfkiln:` message. Up to 1.3.0, they stopped PHP with a TypeError.

Called as `pdfkiln`, bug fixed:

- **Fonts of the input's host** get `--header`, `--cookie` and the cookies that host set, as the page's other requests to it do. Up to 1.3.0, they got none of them. A font that redirects to another host takes none of them there.

Called as `wkhtmltopdf`, `--custom-header` and `--header-html`, now as in wkhtmltopdf 0.12.6:

- **`--custom-header`** goes with each request of the page's redirects. Up to 1.3.0, it went with the first only.
- **`--header-html` and `--footer-html` given by an http or https address** print. Up to 1.3.0, they came out blank, without an error.

Called as `wkhtmltopdf`, cookies, now as in wkhtmltopdf 0.12.6:

- **`--cookie-jar`**: its cookies go with every request whose address they match, whatever the site of the page. Up to 1.3.0, the style sheets, images and fonts of a page opened from a file, or of another site than the page's, went without them: Odoo 15 and later, which pass their session this way, printed their reports without style or header on a server with several databases.
- **`--cookie`**: it goes with every request of a page given as a file or on the standard input, and of a `--header-html` or `--footer-html` page given as a file. Up to 1.3.0, it went with none. Odoo 13 and 14 pass their session this way. From a page loaded from its address, it still goes to that page's host only.
- **The jar file** is read and written back as wkhtmltopdf keeps it. A line Chromium cannot take, such as a path that does not start with `/`, no longer stops the conversion with "unknown error", and the file keeps its order, the lines it cannot use and its expiry dates. The cookies of `--cookie` are no longer written to it, and come after the jar's in each request, a jar cookie of the same name included.
- **Cookies set by a server** for a page of another site, or for a page opened from a file, are kept, sent with the next requests and written to the jar. Up to 1.3.0, they were lost.
- **Secure cookies** of the jar go over https only. Up to 1.3.0, they also went over http to the local machine, such as `http://127.0.0.1`.
- **XMLHttpRequest**: one with `withCredentials` gets the jar's cookies that match its address. Up to 1.3.0, it went without them from a page opened from a file, or to another site than the page's.

Called as `wkhtmltopdf`, fonts and client certificates, now as in wkhtmltopdf 0.12.6:

- **System fonts**: the generic families (`serif`, `sans-serif`, `monospace`, `cursive`, `fantasy`) and text without a family take wkhtmltopdf's fonts where they are installed, Times New Roman, Arial, Courier New, Comic Sans MS and Impact, which `ttf-mscorefonts-installer` installs on Linux. A family that is missing takes the standard one, and without Times New Roman, the font fontconfig gives for Helvetica. Up to 1.3.0, on Linux, they all took that font: a page that wkhtmltopdf set in Times New Roman came out in Liberation Sans or Nimbus Sans, its lines broken elsewhere. On Windows, `cursive` took Times New Roman.
- **`system-ui`**, a keyword that came after wkhtmltopdf's WebKit, is taken as that WebKit takes it: the name of a family that no font has, so the next family of the list applies, else the standard one. Up to 1.3.0, it took the font of Chromium's interface: Segoe UI on Windows, and on Linux a font that fontconfig's rules did not choose, Japanese or mathematical on our servers.
- **Character widths**, on Linux: each character takes the advance its font gives, as wkhtmltopdf places it under fontconfig's default hinting, Debian's included. Up to 1.3.0, PDFKiln's own fontconfig setup, without the system's rules, fell to full hinting, under which Chromium rounds each advance to the pixel: a line of Times New Roman at 16 px was 289 px long instead of 292, and a paragraph could fit one more word per line than in wkhtmltopdf.
- **Web fonts**, which PDFKiln fetches itself, follow `--proxy`, `--custom-header-propagation`, `--username` and `--password`, as the page's other requests do. Up to 1.3.0, they went around the proxy, without the propagated headers and without logging in: a font that only the proxy reaches, or behind a login, stopped the conversion. A font redirected to another host gets there the jar's cookies for that host, and `--cookie` from a page given as a file; up to 1.3.0, it got none there.
- **Client certificate** (`--ssl-crt-path`): the page's https requests, which PDFKiln also makes itself, go through `--proxy` and answer `--username` and `--password`. Up to 1.3.0, they went around the proxy, and a page behind a login stopped the conversion. A request sent without cookies, such as a `fetch` that omits them, goes without them; up to 1.3.0, it took the cookies of its address.

Called as `wkhtmltopdf`, page breaks now as in wkhtmltopdf 0.12.6:

- **Blocks that scroll their overflow** (`overflow: auto` or `scroll`, such as pandoc's code blocks) move whole to the next page when they do not fit at the bottom of one, as images do. Up to 1.3.0, they were split, and the pages after them broke elsewhere than in wkhtmltopdf. A block taller than a page is still split, from where it stands.
- **`break-before`, `break-after`, `break-inside` and `page`**, which came after wkhtmltopdf's WebKit, are ignored as it ignores them; `page-break-before`, `page-break-after` and `page-break-inside` still apply. Up to 1.3.0, Chromium broke pages where wkhtmltopdf did not: at each `break-before: page`, and before and after the elements of a named page.

Called as `wkhtmltopdf`, `--grayscale` now as in wkhtmltopdf 0.12.6:

- **The text stays text**: the PDF is turned grey once assembled, in the greys of wkhtmltopdf's Qt: every colour in DeviceGray with Qt's weights, images, gradients and the pages of `--header-html` and `--footer-html` included. Up to 1.3.0, a CSS filter made Chromium print each page as one image: no text to select, search or read aloud, and a larger file.

## 1.3.0

Three new features, called as `pdfkiln`.

- **Markdown**: `pdfkiln README.md README.pdf` converts Markdown as GitHub writes it (tables, task lists, alerts, footnotes, emoji), math and coloured code included, laid out for paper, from a file or an http or https URL, under the rules of any input. `--from markdown` reads any input as Markdown, the standard input included.
- **PDF/A, for archiving**: `--pdfa` writes PDF/A-3b, or the level asked for: `--pdfa=2b`, `2u`, `3b` or `3u`. A PDF that cannot conform, with a font that is not embedded for instance, is refused rather than labelled.
- **Factur-X and ZUGFeRD invoices**: `--factur-x invoice.xml` attaches the invoice's XML to the PDF, made PDF/A-3: the page a person reads and the data the recipient's software reads, in one file. PDFKiln checks that the XML is a Cross Industry Invoice and reads its profile (MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED or XRECHNUNG); it does not write the XML, nor check its business rules.

```sh
pdfkiln README.md README.pdf
pdfkiln --pdfa report.html report.pdf
pdfkiln --factur-x invoice.xml invoice.html invoice.pdf
```

Security:

- Chromium 157.0.8103.78 → 158.0.8127.36 ([release notes](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop_01699533288.html)).
- Called as `pdfkiln`, a web font from a server whose certificate does not verify is refused, as the page and its other resources already were: up to 1.2.1, it loaded. The new `--allow-invalid-certificates` lets pages load from such servers (self-signed, expired, issued for another name), fonts included.

Bugs fixed:

- On Windows, a conversion could end with "ERROR: The process "…" not found." on stderr, written by taskkill as Chromium was already leaving. The PDF and the exit code were right.

Called as `wkhtmltopdf`, bugs fixed:

- A page or a resource over https whose certificate does not verify (self-signed, expired, issued for another name) loads, with the warning "SSL error ignored", as in wkhtmltopdf and wkhtmltoimage 0.12.6: the conversion failed with "SslHandshakeFailedError", even with `--load-error-handling ignore`, and such an image in an http page was left out. The new `--kiln-block-invalid-certificates` refuses them, fonts included.
- A page whose server refuses the connection fails as in wkhtmltopdf 0.12.6: "Failed to load <url>, with network status code 1 and http status code 0 - Connection refused", then exit 1 with "ConnectionRefusedError", also with `--load-error-handling skip` or `ignore`, which keep the PDF. Up to 1.2.1, the last line read "unknown error", and `skip` or `ignore` exited 0.
- A `--header-html` or `--footer-html` page that does not load stops the conversion, without a PDF, as in wkhtmltopdf 0.12.6. With `--load-error-handling ignore` or `skip`, the PDF is kept, and the header of each page says it failed. Up to 1.2.1, the PDF was written without the header.
- `[time]` and `[date]` are written as wkhtmltopdf 0.12.6 writes them: the time with its seconds on Windows, and `16:37:26` and `17 Nov 2026` on Linux without a locale (`C`, the usual case of servers and containers), where 1.2.1 wrote `4:37 PM` and `11/17/26`.
- A `--user-style-sheet` given as an http or https URL, which wkhtmltopdf ignores, is loaded as the page's style sheets are: through `--proxy`, with the page's cookies, headers and authentication, and under the same refusals. It went to the server directly, without them.

## 1.2.1

Security:

- Chromium 157.0.8103.50 → 157.0.8103.78 ([release notes](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop_01744469280.html)).

Bugs fixed:

- A resource from another site that answers in error and that Chromium keeps from the page (HTML served for an image, a response without CORS headers) fails the conversion, as in wkhtmltopdf 0.12.6 and as `pdfkiln --fail-on-resource-error` asks: on a slow machine, its error could come too late, and the conversion exited 0.

## 1.2.0

`pdfkiln serve` is removed: each conversion starts its own Chromium. The command line of wkhtmltopdf and wkhtmltoimage does not change.

Security:

- Chromium 157.0.8103.38 → 157.0.8103.50 ([release notes](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop_018223192.html)).
- Node.js 24.22.2 → 24.22.3.
- The private network block (`pdfkiln` by default, `--kiln-block-private-network` as `wkhtmltopdf`) let through an IPv4 address written in IPv6 form, such as `http://[::ffff:127.0.0.1]/`, since 1.0.2. Such an address is now judged as the IPv4 address it carries.
- The Linux and macOS archives give their files to root: unpacked by root, they belonged to the account that built them, which could replace the program.
- Composer package: without `HOME` (php-fpm's default), the cache no longer goes to the shared temporary folder, where another account could put a program first. When the cache moves, Chromium is downloaded once more.
- The npm package keeps Node's compile cache in PDFKiln's cache folder, no longer in a folder of the temporary folder shared by every account.
- The program is built on the official Node.js archive of its version, checked against its SHA-256, rather than on the Node.js of the machine that builds it.

`pdfkiln serve`, what breaks:

- `pdfkiln serve` exits 1, with "pdfkiln serve was removed in 1.2.0: each conversion starts its own Chromium". Take it out of your scripts and service definitions (Docker, launchd, systemd): conversions work without it. Those who ran it lose what it saved, about 0.17 s per conversion on Linux and 0.06 s on macOS; it was off on Windows.
- `wkhtmltopdf` and `wkhtmltoimage` no longer look for a server: `PDFKILN_SERVER` has no effect, and a 1.1 server that still runs is ignored; stop it. Pages render with the command's time zone and language (`TZ`, `LANG`) again, not the server's.
- Debian package: the `pdfkiln@.service` unit is gone. The update stops and disables the `pdfkiln@` units itself: nothing to do.

Called as `pdfkiln`, what is new:

- `--fail-on-resource-error`: a resource that does not load (image, font, style sheet, frame, request of a script) fails the conversion, where it was a warning and the PDF went without it: exit 1, no PDF, and `could not load <url>: <why>` for each, lazy images included; `-q` does not hide them.
- `--title`, `--author`, `--subject` and `--keywords`: the PDF's properties, `--title` named as in wkhtmltopdf. Without them, nothing changes: the title is the page's `<title>`, the others are not set.

Faster:

- Long documents and tagged PDFs, much faster on Windows: 72 pages as `wkhtmltopdf` take 2.5 s instead of 7.2 s, and 87 pages as `pdfkiln --tagged` 2.1 s instead of 26.8 s. Less so on Linux.
- Several pages in one `wkhtmltopdf` call (Odoo passes one per record) take half the memory: 20 one-page invoices with a header and a footer, 0.74 GB instead of 1.6 GB and 4.1 s instead of 5.1 s on Windows 11.
- Each conversion starts a little sooner. On Linux with many fonts, Chromium starts sooner as `wkhtmltopdf`: 0.43 s instead of 0.64 s with ten thousand fonts.

Called as `wkhtmltopdf`, closer to wkhtmltopdf:

- `--dpi` sets the resolution of lengths in pixels and of the automatic header and footer margins, as in wkhtmltopdf, rather than warn that it has no effect. Odoo passes it on every call.
- The parameters a `--header-html` or `--footer-html` page receives are encoded as wkhtmltopdf encodes them, so a script that decodes them with `decodeURI` reads `[date]` and `[time]`. A `+` in the page's path no longer stops it from loading.
- `--user-style-sheet` takes a `data:` URL.
- `--read-args-from-stdin` converts each line as it arrives: a caller may wait for a PDF before it writes the next line.
- A `--cookie-jar` that cannot be read or written no longer fails the conversion.

Bugs fixed:

- A long document no longer fails after 30 s of printing with "Timed out after waiting 30000ms": only `--timeout` and `--kiln-timeout` bound a conversion. Beyond 24 days, they mean no limit; they stopped the conversion at once.
- Ctrl+C, SIGTERM or SIGHUP during a conversion no longer leaves its temporary folder behind.
- `wkhtmltopdf`: a `--header-html` or `--footer-html` page that fails to load, or a failure of PDFKiln's own, such as a `--header-html` that names no file, ends on wkhtmltopdf's last line, `Exit with code 1, due to unknown error.`, rather than a stack trace, and leaves no temporary folder.
- Windows installer: uninstalling removes its own entry from the `PATH` only; it could cut another one that started the same way.
- Docker image: about 100 MB smaller.
- On Linux, emoji print in colour rather than as empty boxes: the Debian package recommends `fonts-noto-color-emoji`, and the Docker image includes it.
- The packages include the license of each library bundled in PDFKiln, in `licenses/`; most were missing.
- `pdfkiln --outline`: a heading that a page break pushes to the next page no longer has its text twice in its bookmark ("InstallationInstallation").

## 1.1.2

Security:

- Chromium 156.0.8078.80 → 157.0.8103.38 ([release notes](https://chromereleases.googleblog.com/2026/11/stable-channel-update-for-desktop.html)).
- `wkhtmltopdf` and `wkhtmltoimage` ignore a `pdfkiln serve` that runs another Chromium version than theirs, one started before an update for example, and start their own; restart the server to use it again.
- On Windows, `pdfkiln serve` is off: another account on the machine could pose as it. It comes back once a command can check that the server is its own.
- Debian package: a running `pdfkiln@<user>` restarts on update, so it runs the new Chromium; up to 1.1.1, it kept the old one. A conversion under way at that moment fails. Removing the package stops it.

In every mode:

- Node.js 24.22.1 → 24.22.2 on Linux and macOS; Windows already had 24.22.2.

Bugs fixed:

- `--kiln-timeout` also bounds the wait for `pdfkiln serve`: a server whose Chromium no longer answered held each conversion forever.
- `pdfkiln serve --socket` no longer sets an existing folder to mode 0700 (a home folder, for example); the socket itself is private.
- `pdfkiln serve` no longer grows in memory as it runs: it kept all that Chromium wrote on its error output, and the browser contexts of conversions stopped while they began.
- A `pdfkiln serve` that fails to start because another one runs no longer removes that one's socket.
- `pdfkiln serve` says why it cannot listen on its socket, instead of a stack trace.

Called as `pdfkiln`:

- `pdfkiln --help` is easier to read: examples first, options grouped, commands listed.

## 1.1.1

Security:

- Up to 1.1.0, any local account could replace the program that root, the web server or Odoo run: the file `pdfkiln` was writable by every user (mode 0777) in the Debian package and the Docker image (`/usr/lib/pdfkiln/pdfkiln`), and could be in the Linux and macOS archives unpacked as root. 1.1.1 installs every file writable by its owner only. Until you update, as root: `chmod 755 /usr/lib/pdfkiln/pdfkiln`, or the same on the `pdfkiln` file of an unpacked archive.

The project has moved to the pdfkiln organization, https://github.com/pdfkiln/pdfkiln; the old addresses redirect.

- The Docker image is `ghcr.io/pdfkiln/pdfkiln`: `ghcr.io/jamalofski/pdfkiln` stays at 1.1.0. Change the image in your `docker pull` commands and compose files.
- The files of 1.1.0 and earlier verify with `gh attestation verify <file> --owner Jamalofski`, those of 1.1.1 and later with `--repo pdfkiln/pdfkiln`.

In every mode:

- On Linux, PDFKiln works under a soft cap on the address space (RLIMIT_AS, `ulimit -v`), as wkhtmltopdf does. Odoo 16 to 20 set one on the programs they start, in every server mode (`limit_memory_hard`, 2560 MiB by default): 1.1.0 failed under it ("…Target closed") and Odoo printed no PDF. A hard cap cannot be lifted by the program it applies to: the conversion then fails with a message that says so, and how to lift it.
- On Linux, where the system refuses the user namespaces PDFKiln's sandbox needs (Docker's default seccomp profile, unprivileged user namespaces turned off), the conversion fails with a message that says so and gives the fix (PDFKiln's seccomp profile, in a container), where 1.1.0 only said "…Target closed".
- On Linux, the program takes 18 MB less on disk (111 MB instead of 129) and about 3 MB less to download: Node's symbol table and debug sections, which only a debugger reads, are left out.
- The PDFs' Creator, the Application field of PDF viewers, reads `PDFKiln 1.1.1`, where 1.1.0 wrote `pdfkiln`; called as `pdfkiln`, so does the first word of `--version`. The Producer stays `pdfkiln.org`, the commands and packages `pdfkiln`. The version tells whoever receives a PDF which release made it: keep PDFKiln up to date.
- On Windows, the installer and the list of installed apps give PDFKiln as the name and the publisher, where 1.1.0 gave pdfkiln and Jamalofski.

Installed with Composer or npm:

- The user's cache no longer keeps every version it downloaded, about 400 MB each with Composer, 280 MB with npm: a version no project uses any more is deleted at the next call, before the new one is downloaded. Sites of one account on different versions each keep theirs as long as they use it, behind `open_basedir` too. The versions left by 1.1.0 and earlier go once they have not run for 30 days.

Called as `wkhtmltopdf`, bugs fixed:

- A host not found over https reads "Host  not found", without its name, as wkhtmltopdf writes it: 1.1.0 named the host, which wkhtmltopdf does over http only.

## 1.1.0

Called as `pdfkiln`, five changes break commands that worked with 1.0.4; each says what to do.

In every mode:

- Pages that send CSP reports or beacons (https://www.google.fr), or whose responses are blocked as unsafe (HTML for an image, an API without CORS headers), no longer fail the conversion: called as `wkhtmltopdf`, pdfkiln exited 1 with "network status code 99". An HTTP error on such a response still fails, as with wkhtmltopdf.
- The PDFs no longer give the versions of the software that made them, which told whoever receives one whether the server runs a version with known flaws: Creator is `pdfkiln`, Producer `pdfkiln.org`.

Called as `wkhtmltopdf`, bugs fixed:

- A local file that does not exist, in a folder given to `--allow`, is refused as wkhtmltopdf refuses it ("Blocked access to file", exit 1): 1.0.4 let it through, except on macOS under `/tmp` or `/var`.
- On Windows, "Blocked access to file" and "Error opening" write the path with `/`, as wkhtmltopdf does.

Called as `pdfkiln`, what breaks:

- Private addresses (localhost, the private network, `169.254.169.254`) are refused by default: add `--allow-private-network` for a local server or an intranet.
- `--block-private-network` is gone, the refusal being the default: remove it from your commands.
- An input that does not load, refused, unreachable or in HTTP error, fails: exit 1 and no PDF, where 1.0.4 wrote a blank page and exited 0. Test the exit code.
- The messages are pdfkiln's own: one error for an input that does not load, `could not load <input>: <why>` (`HTTP 404`, `host not found`, `no such file`, `10.0.0.1 is a private address`…), and a warning for each resource that does not, which `-q` hides. Programs that read stderr: read these lines.
- An input without a scheme is a file: write `https://www.example.com`, not `www.example.com`.

Called as `pdfkiln`, what is new:

- `--header "name: value"` and `--cookie name=value`, sent to the input's host only: pages behind a login.
- `--wait-for <selector>`: waits for an element the page adds once ready; `--timeout` bounds it.
- `--css <file>`: a style sheet after the page's own, for the paper, the margins or what not to print.
- `--media screen`: the page's screen rules instead of its print rules.

## 1.0.4

- Security: Chromium 156.0.8078.73 → 156.0.8078.80 ([release notes](https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_02107719452.html)).
- `--no-custom-header-propagation` turns the propagation on, as in wkhtmltopdf 0.12.6, where it does what `--custom-header-propagation` does; up to 1.0.3, pdfkiln turned it off. Commands written for wkhtmltopdf that pass it send their `--custom-header` with every request again.
- On Windows Server Core, where pdfkiln cannot render, the conversion fails with a message that says so, instead of "Target closed". Windows Server with the Desktop Experience runs pdfkiln, IIS included: now tested as the application pool's identity.
- On Linux, a missing system library (the archive and the Composer package do not carry them) is named in the error, instead of "Target closed"; the README lists the Debian and Ubuntu packages.
- `pdfkiln serve` no longer crashes when it cannot start rendering: it reports why, as a conversion does.
- The packages (npm, Debian, Docker image, Windows installer, Scoop, winget, Homebrew, Composer) give https://pdfkiln.org as the home page.

## 1.0.3

- Security: Chromium 156.0.8078.47 → 156.0.8078.73 ([release notes](https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_0562499947.html)).
