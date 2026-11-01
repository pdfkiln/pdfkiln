# Changes

What each version changes, for those who use it. A version's release notes
open with its section here (scripts/release.ts): no release without one.
They name Chromium only when the version changes it, with its new version
first. Up to 1.0.2, see each version's GitHub release.

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

- Security: the 21 fixes of Chrome 156.0.8078.79, 1 of them rated Critical by Google (MediaStream) and 19 High: [Google's announcement](https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_02107719452.html). pdfkiln renders the pages it is given with this Chromium: update.
- `--no-custom-header-propagation` turns the propagation on, as in wkhtmltopdf 0.12.6, where it does what `--custom-header-propagation` does; up to 1.0.3, pdfkiln turned it off. Commands written for wkhtmltopdf that pass it send their `--custom-header` with every request again.
- On Windows Server Core, where pdfkiln cannot render, the conversion fails with a message that says so, instead of "Target closed". Windows Server with the Desktop Experience runs pdfkiln, IIS included: now tested as the application pool's identity.
- On Linux, a missing system library (the archive and the Composer package do not carry them) is named in the error, instead of "Target closed"; the README lists the Debian and Ubuntu packages.
- `pdfkiln serve` no longer crashes when it cannot start rendering: it reports why, as a conversion does.
- The packages (npm, Debian, Docker image, Windows installer, Scoop, winget, Homebrew, Composer) give https://pdfkiln.org as the home page.

## 1.0.3

- Security: the 52 fixes of Chrome 156.0.8078.73, 4 of them rated Critical by Google (Layout, Skia, FileSystem, FileAPI) and 46 High: [Google's announcement](https://chromereleases.googleblog.com/2026/10/stable-channel-update-for-desktop_0562499947.html). pdfkiln renders the pages it is given with this Chromium: update.
