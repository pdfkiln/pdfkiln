# Installation

PDFKiln's packages, the systems each is built and tested for, and what it installs. The [README](../README.md#installation) gives the commands alone.

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

**Docker** (amd64 and arm64), on Debian 13 slim, as an unprivileged user, with Liberation, DejaVu and the colour emoji font. Docker's default seccomp profile stops Chromium's sandbox; [`docker/seccomp.json`](../docker/seccomp.json) is that profile plus the namespaces the sandbox needs:

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

## Chromium's sandbox

Chromium's sandbox stays on: run PDFKiln as an unprivileged user, not root. The sandbox needs a user namespace, and a PID and a network namespace in it. Where the system refuses them, Chromium cannot start, and PDFKiln says why and what allows them:

- **Docker**: its default seccomp profile refuses them; run the container with [`docker/seccomp.json`](../docker/seccomp.json), as above.
- **AppArmor**, on Ubuntu 23.10 and later, allows them only to programs with a profile that allows them. The Debian package loads one for its Chromium; for the Chromium of an archive or of the npm or Composer package, load one that names it.
- **A systemd unit with `RestrictNamespaces=`**, such as php-fpm's from [packages.sury.org](https://packages.sury.org/php/) and the [ondrej/php PPA](https://launchpad.net/~ondrej/+archive/ubuntu/php): their unit has the hardening of PHP's own, `RestrictNamespaces=true` among it, which refuses every namespace, so a PHP application's PDFs fail where the same command works in a shell. Debian 13's own php-fpm refuses none. Allow the three the sandbox needs in a drop-in, which keeps the rest of the unit's hardening; for php8.5-fpm, each PHP version having its own unit:

  ```sh
  sudo mkdir -p /etc/systemd/system/php8.5-fpm.service.d
  printf '[Service]\nRestrictNamespaces=user pid net\n' | sudo tee /etc/systemd/system/php8.5-fpm.service.d/pdfkiln.conf
  sudo systemctl daemon-reload && sudo systemctl restart php8.5-fpm
  ```

  `sudo systemctl edit php8.5-fpm`, with the same two lines, does the same. wkhtmltopdf, which has no sandbox, ran under such a unit as it is.
- **A kernel that turns them off** for unprivileged users, with `user.max_user_namespaces` at 0, or `kernel.unprivileged_userns_clone` at 0 where the kernel has it: raise the first, set the second to 1.

`--kiln-no-sandbox` (`--no-sandbox` called as `pdfkiln`) works around each of them, not recommended.

## Releases

Each release is built and tested by CI, then published by hand from two green runs (`.github/workflows/release.yml`, `apt.yml`, `npm.yml`, `docker.yml`), with SHA-256 sums and build provenance attestations (`gh attestation verify <file> --repo pdfkiln/pdfkiln`; up to 1.1.0, before the move to the pdfkiln organization, `--owner Jamalofski`).
