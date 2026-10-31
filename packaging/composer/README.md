# PDFKiln for Composer

`vendor/bin/wkhtmltopdf` and `vendor/bin/wkhtmltoimage`: [PDFKiln](https://pdfkiln.org), a drop-in replacement for wkhtmltopdf 0.12.6 rendered by Chromium.

```
composer require pdfkiln/pdfkiln
```

```php
$snappy = new Knp\Snappy\Pdf(Pdfkiln\binary());
```

`Pdfkiln\binary()` returns the path of the program itself (`binary('wkhtmltoimage')` for the other one), downloaded first if needed. On Linux and macOS, `__DIR__ . '/vendor/bin/wkhtmltopdf'` works as well; on Windows, knp-snappy refuses the `.bat` Composer writes there, as PHP's `is_executable` only accepts `.exe` and `.com` files.

The package holds no binary: on first use, `vendor/bin/wkhtmltopdf` or `Pdfkiln\binary()` downloads the archive of the platform (Linux, macOS, Windows, about 150 MB) from GitHub Releases, checks it against the SHA-256 sum in `pins.json`, unpacks it in the user's cache (`~/.cache/pdfkiln`, `~/Library/Caches/pdfkiln`, `%LOCALAPPDATA%\pdfkiln`; `PDFKILN_CACHE_DIR` changes it), then runs it. Later calls run it directly. To download it during a deployment rather than on the first request, run `vendor/bin/wkhtmltopdf --version` once, as the user the web server runs PHP as, or with the same `PDFKILN_CACHE_DIR`.

On Linux, Chromium needs its system libraries (`libnss3`, `libgbm1` and others) and, on Ubuntu 24.04, an AppArmor profile for its sandbox: the Debian package and the Docker image bring both, so prefer them on a Linux server ([Installation](https://github.com/pdfkiln/pdfkiln#installation)). This package suits Windows and macOS machines, and Linux ones that already have those libraries.

PHP 7.4 or later; `tar` (Linux, macOS, Windows 10 and later).

PDFKiln is not affiliated with the wkhtmltopdf project. MIT license.
