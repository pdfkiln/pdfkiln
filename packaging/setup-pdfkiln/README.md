# setup-pdfkiln

A GitHub Action that installs [PDFKiln](https://pdfkiln.org), the drop-in replacement for wkhtmltopdf powered by Chromium, and puts `wkhtmltopdf`, `wkhtmltoimage` and `pdfkiln` on the `PATH`: the tests of a project that calls wkhtmltopdf run unchanged, on runners where wkhtmltopdf no longer installs (Ubuntu 25.04 and later, macOS without its Homebrew cask).

```yaml
- uses: pdfkiln/pdfkiln/packaging/setup-pdfkiln@main
- run: wkhtmltopdf --version
```

The release archive of the runner's platform is checked against the release's `SHA256SUMS`, then kept in the tool cache. Platforms: Linux x64 and ARM64, macOS ARM64, Windows x64 (ARM in emulation). On Ubuntu 23.10 and later, the action loads the AppArmor profile Chromium's sandbox needs (with `sudo`, which GitHub's runners allow).

| Input | Default | |
| --- | --- | --- |
| `version` | `latest` | a release, such as `1.1.0` |
| `token` | `github.token` | asks the GitHub API for the latest release |

| Output | |
| --- | --- |
| `version` | the version installed |
| `path` | the folder of `wkhtmltopdf`, `wkhtmltoimage` and `pdfkiln` |

In a container job, Chromium needs the system libraries the Debian package depends on, and Docker's default seccomp profile stops its sandbox: see the [README of PDFKiln](https://github.com/pdfkiln/pdfkiln#installation).

PDFKiln is not affiliated with the wkhtmltopdf project. MIT license.
