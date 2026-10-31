<?php
// The Composer package of pdfkiln. A repository cannot carry a 150 MB
// program for each Chromium version: the package holds the release's
// SHA-256 sums (pins.json), and the first call downloads the archive of the
// platform from GitHub Releases, checks it, unpacks it in the user's cache
// and runs it. Later calls run it directly, with the same standard input,
// output, error and exit code. binary() gives the program's own path, for
// libraries that check it is executable: on Windows, PHP's is_executable
// is false for the .bat Composer writes next to each program.
//
// PDFKILN_CACHE_DIR changes the cache folder, as for the npm package.

namespace Pdfkiln;

// STDERR exists on the command line only, not under php-fpm.
function say(string $message): void
{
    if (\defined('STDERR')) fwrite(STDERR, "pdfkiln: $message\n");
}

function cacheDir(): string
{
    $env = getenv('PDFKILN_CACHE_DIR');
    if ($env) return $env;
    if (PHP_OS_FAMILY === 'Windows') return (getenv('LOCALAPPDATA') ?: getenv('USERPROFILE') . '\\AppData\\Local') . '\\pdfkiln';
    $home = getenv('HOME') ?: sys_get_temp_dir();
    if (PHP_OS_FAMILY === 'Darwin') return "$home/Library/Caches/pdfkiln";
    return (getenv('XDG_CACHE_HOME') ?: "$home/.cache") . '/pdfkiln';
}

// The platform names of the archives (scripts/package.ts).
function platform(): ?string
{
    $arm = in_array(strtolower(php_uname('m')), ['arm64', 'aarch64'], true);
    switch (PHP_OS_FAMILY) {
        case 'Linux': return $arm ? 'linux-arm64' : 'linux-x64';
        case 'Darwin': return $arm ? 'macos-arm64' : 'macos-x64';
        case 'Windows': return 'windows-x64';
    }
    return null;
}

function removeTree(string $path): void
{
    if (is_dir($path) && !is_link($path)) {
        foreach (scandir($path) as $f) if ($f !== '.' && $f !== '..') removeTree($path . DIRECTORY_SEPARATOR . $f);
        @rmdir($path);
    } else {
        @unlink($path);
    }
}

function run(array $cmd): int
{
    $p = proc_open($cmd, [0 => STDIN, 1 => STDOUT, 2 => STDERR], $pipes);
    return is_resource($p) ? proc_close($p) : 1;
}

// Downloads, checks and unpacks the archive; another process doing the
// same at the same time does no harm: each works in its own folder, the
// first rename wins.
function install(array $pins, string $platform, string $dir): ?string
{
    $file = "pdfkiln-{$pins['version']}-$platform" . ($platform === 'windows-x64' ? '.zip' : '.tar.gz');
    $sha = $pins['sha256'][$file] ?? null;
    if (!$sha) return "no build for $platform in this version";
    $parent = dirname($dir);
    if (!is_dir($parent) && !@mkdir($parent, 0700, true) && !is_dir($parent)) return "cannot create $parent";
    $tmp = $parent . DIRECTORY_SEPARATOR . 'tmp-' . bin2hex(random_bytes(6));
    mkdir($tmp, 0700);
    try {
        return fetch($pins, $file, $sha, $tmp, $dir);
    } finally {
        if (is_dir($tmp)) removeTree($tmp);
    }
}

function fetch(array $pins, string $file, string $sha, string $tmp, string $dir): ?string
{
    $archive = $tmp . DIRECTORY_SEPARATOR . $file;
    say("downloading $file (first use)");
    $in = @fopen("{$pins['url']}/$file", 'rb');
    if (!$in) {
        $hint = strncmp($pins['url'], 'https:', 6) === 0 && !\extension_loaded('openssl') ? ": PHP's openssl extension is not loaded" : '';
        return "cannot download {$pins['url']}/$file$hint";
    }
    $out = fopen($archive, 'wb');
    stream_copy_to_stream($in, $out);
    fclose($in);
    fclose($out);
    if (!hash_equals($sha, hash_file('sha256', $archive))) return "$file does not match its SHA-256: not used";
    // The system's tar unpacks both formats, links included (Windows 10 and
    // later have tar.exe).
    $tar = PHP_OS_FAMILY === 'Windows' ? (getenv('SystemRoot') ?: 'C:\\Windows') . '\\System32\\tar.exe' : 'tar';
    $p = proc_open([$tar, '-xf', $archive, '-C', $tmp], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $err = stream_get_contents($pipes[2]);
    if (proc_close($p) !== 0) return "cannot unpack $file: $err";
    unlink($archive);
    if (!@rename($tmp, $dir) && !is_dir($dir)) return "cannot install in $dir";
    return null;
}

// The path of the program `name` (wkhtmltopdf, wkhtmltoimage or pdfkiln),
// downloaded first if needed:
//   new Knp\Snappy\Pdf(\Pdfkiln\binary());
function binary(string $name = 'wkhtmltopdf'): string
{
    $pins = json_decode((string) file_get_contents(__DIR__ . '/../pins.json'), true);
    $platform = platform();
    if (!$pins || !$platform) throw new \RuntimeException('pdfkiln: no build of PDFKiln for this system');
    $dir = cacheDir() . DIRECTORY_SEPARATOR . 'dist' . DIRECTORY_SEPARATOR . "{$pins['version']}-$platform";
    $exe = $platform === 'windows-x64'
        ? "$dir\\wkhtmltopdf\\bin\\$name.exe"
        : "$dir/pdfkiln-{$pins['version']}-$platform/$name";
    if (!is_file($exe)) {
        $error = install($pins, $platform, $dir);
        if ($error) throw new \RuntimeException("pdfkiln: $error");
    }
    return $exe;
}

function launch(string $name, array $args): int
{
    try {
        $exe = binary($name);
    } catch (\RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        return 1;
    }
    return run(array_merge([$exe], $args));
}
