# Changes

What each version changes, for those who use it. A version's release notes
open with its section here (scripts/release.ts): no release without one.
A version that changes Chromium says so under Security: the two versions,
and a link to Google's release notes. Up to 1.0.2, see each version's
GitHub release.

## 1.3.0

Three new features, called as `pdfkiln`. The command line of wkhtmltopdf and wkhtmltoimage does not change.

- **Markdown**: `pdfkiln README.md README.pdf` converts Markdown as GitHub writes it (tables, task lists, alerts, footnotes, emoji), math and coloured code included, laid out for paper. `--from markdown` reads any input as Markdown, the standard input included.
- **PDF/A, for archiving**: `--pdfa` writes PDF/A-3b, or the level asked for: `--pdfa=2b`, `2u`, `3b` or `3u`. A PDF that cannot conform, with a font that is not embedded for instance, is refused rather than labelled.
- **Factur-X and ZUGFeRD invoices**: `--factur-x invoice.xml` attaches the invoice's XML to the PDF, made PDF/A-3: the page a person reads and the data the recipient's software reads, in one file. PDFKiln checks that the XML is a Cross Industry Invoice and reads its profile (MINIMUM, BASIC WL, BASIC, EN 16931, EXTENDED or XRECHNUNG); it does not write the XML, nor check its business rules.

```sh
pdfkiln README.md README.pdf
pdfkiln --pdfa report.html report.pdf
pdfkiln --factur-x invoice.xml invoice.html invoice.pdf
```

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
