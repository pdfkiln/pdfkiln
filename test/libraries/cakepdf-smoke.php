<?php
// CakePdf's WkHtmlToPdf engine driving the binary for real: its own tests
// only build command lines. Usage: php cakepdf-smoke.php <vendor/autoload.php> <binary>
require $argv[1];

use CakePdf\Pdf\CakePdf;

$failures = 0;
$check = function ($name, $ok) use (&$failures) {
    echo ($ok ? 'ok' : 'FAILED') . " - $name\n";
    if (!$ok) $failures++;
};
$isPdf = fn ($s) => is_string($s) && strncmp($s, '%PDF-', 5) === 0;
$make = fn (array $options = []) => new CakePdf(['engine' => [
    'className' => 'CakePdf.WkHtmlToPdf', 'binary' => $argv[2], 'options' => $options,
]]);

// The engine passes --quiet --print-media-type, the orientation, the page
// size, the encoding and the title on every call, and the HTML on stdin.
$check('output', $isPdf($make()->output('<h1>CakePdf</h1>')));
$pdf = $make(['outline' => true, 'footer-font-size' => 8]);
$pdf->orientation('landscape');
$pdf->pageSize('A5');
$pdf->margin(15, 10, 15, 10);
$pdf->title('CakePdf rules');
$pdf->footer(null, 'Page [page] of [topage]', null);
$pdf->header('Left', null, 'Right');
$check('output with page settings, header and footer', $isPdf($pdf->output('<h1>Settings</h1>')));
$tmp = sys_get_temp_dir() . '/cakepdf-smoke-' . getmypid();
@mkdir($tmp);
file_put_contents("$tmp/cover.html", '<h1>Cover</h1>');
$pdf = $make(['enable-local-file-access' => true, 'cover' => ['url' => "$tmp/cover.html", 'zoom' => 1], 'toc' => ['disable-dotted-lines' => true]]);
$check('cover and toc', $isPdf($pdf->output('<h1>Chapter</h1><h2>Section</h2>')));
$make()->write("$tmp/out.pdf", true, '<h1>Written</h1>');
$check('write', $isPdf(@file_get_contents("$tmp/out.pdf")));
exit($failures ? 1 : 0);
