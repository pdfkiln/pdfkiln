# PDFKiln for Composer

`vendor/bin/wkhtmltopdf` and `vendor/bin/wkhtmltoimage`: [PDFKiln](https://pdfkiln.org), a drop-in replacement for wkhtmltopdf 0.12.6 rendered by Chromium.

```
composer require pdfkiln/pdfkiln
```

```php
$snappy = new Knp\Snappy\Pdf(Pdfkiln\binary());
```

`Pdfkiln\binary()` returns the path of the program itself (`binary('wkhtmltoimage')` for the other one), downloaded first if needed. On Linux and macOS, `__DIR__ . '/vendor/bin/wkhtmltopdf'` works as well; on Windows, knp-snappy refuses the `.bat` Composer writes there, as PHP's `is_executable` only accepts `.exe` and `.com` files.

The package holds no binary: on first use, `vendor/bin/wkhtmltopdf` or `Pdfkiln\binary()` downloads the archive of the platform (Linux, macOS, Windows, about 150 MB) from GitHub Releases, checks it against the SHA-256 sum in `pins.json`, unpacks it in the user's cache (`~/.cache/pdfkiln`, `~/Library/Caches/pdfkiln`, `%LOCALAPPDATA%\pdfkiln`; `PDFKILN_CACHE_DIR` changes it), then runs it. Later calls run it directly. An account that cannot write in its home folder, such as `www-data` on a web server, gets `/var/tmp/pdfkiln-<uid>` instead. The cache records the projects that use it: once none of them pins a version any more, the next call deletes it; a version pinned by a project whose folder this one cannot read, another site behind `open_basedir` for instance, stays until 30 days after that project's last call.

## On a web server

php-fpm gives PHP the home folder of the pool's user, `/var/www` for `www-data`, which root owns on Debian and Ubuntu, and Apache's mod_php gives it none: the program goes to `/var/tmp/pdfkiln-<uid>`, which stays across reboots. To download it during a deployment rather than on the first request, run it once from the project's folder, as that user; the download says where it puts the program:

```
sudo -u www-data vendor/bin/wkhtmltopdf --version
```

For a folder of its own, out of reach of the cleaning of `/var/tmp` (Debian 13 deletes what goes unused there for 30 days), make it for that user, name it in the pool (`/etc/php/8.4/fpm/pool.d/www.conf` on Debian 13), reload php-fpm, and give it to the download too:

```
sudo install -d -o www-data -g www-data -m 0700 /var/cache/pdfkiln
```

```ini
env[PDFKILN_CACHE_DIR] = /var/cache/pdfkiln
```

```
sudo -u www-data env PDFKILN_CACHE_DIR=/var/cache/pdfkiln vendor/bin/wkhtmltopdf --version
```

Under Apache's mod_php, name the folder in `/etc/apache2/envvars` rather than in a pool, then restart Apache. Its service has a `/var/tmp` of its own on Debian and Ubuntu (`PrivateTmp`), which it empties at each restart and which a download run from a shell does not reach: without this line, the first PDF after each restart downloads the program again.

```
export PDFKILN_CACHE_DIR=/var/cache/pdfkiln
```

php-fpm from packages.sury.org and the ondrej/php PPA runs in a systemd unit hardened as PHP's own is, which refuses every namespace (`RestrictNamespaces=true`), the three Chromium's sandbox needs included. The PDFs then fail with `Chromium's sandbox cannot start`, in a message that names the unit, while the same command works in a shell. Allow those three in a drop-in, which keeps the rest of the unit's hardening, and restart php-fpm; for php8.5-fpm:

```
sudo mkdir -p /etc/systemd/system/php8.5-fpm.service.d
printf '[Service]\nRestrictNamespaces=user pid net\n' | sudo tee /etc/systemd/system/php8.5-fpm.service.d/pdfkiln.conf
sudo systemctl daemon-reload && sudo systemctl restart php8.5-fpm
```

On Linux, Chromium needs its system libraries (`libnss3`, `libgbm1` and others) and, on Ubuntu 24.04, an AppArmor profile for its sandbox: the Debian package and the Docker image bring both, so prefer them on a Linux server ([Installation](https://github.com/pdfkiln/pdfkiln#installation)). This package suits Windows and macOS machines, and Linux ones that already have those libraries.

PHP 7.4 or later; `tar` (Linux, macOS, Windows 10 and later).

PDFKiln is not affiliated with the wkhtmltopdf project. MIT license.
