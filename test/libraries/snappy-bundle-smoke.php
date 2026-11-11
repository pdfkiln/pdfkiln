<?php
// KnpSnappyBundle driving the binaries for real, through its services and
// responses: its own tests only check its configuration. Usage:
// php snappy-bundle-smoke.php <bundle dir> <wkhtmltopdf> <wkhtmltoimage>
$bundle = realpath($argv[1]);
require "$bundle/vendor/autoload.php";

use Knp\Bundle\SnappyBundle\Snappy\Response\JpegResponse;
use Knp\Bundle\SnappyBundle\Snappy\Response\PdfResponse;
use Knp\Bundle\SnappyBundle\Tests\TestKernel;
use Symfony\Component\Filesystem\Filesystem;

$failures = 0;
$check = function ($name, $ok) use (&$failures) {
    echo ($ok ? 'ok' : 'FAILED') . " - $name\n";
    if (!$ok) $failures++;
};

// The bundle's test kernel, its binaries set as an application sets them.
$config = sys_get_temp_dir() . '/snappy-bundle-smoke-' . getmypid() . '.yml';
file_put_contents($config, "imports:\n    - { resource: '$bundle/tests/fixtures/config/base.yml' }\n"
    . "knp_snappy:\n    pdf:\n        binary: '$argv[2]'\n    image:\n        binary: '$argv[3]'\n");
$kernel = new TestKernel('smoke' . getmypid(), false);
$kernel->setConfigurationFilename($config);
$kernel->boot();
$container = $kernel->getContainer();

$pdf = new PdfResponse($container->get('knp_snappy.pdf')->getOutputFromHtml('<h1>Bundle</h1>'), 'file.pdf');
$check('knp_snappy.pdf in a PdfResponse', strncmp($pdf->getContent(), '%PDF-', 5) === 0);
$image = new JpegResponse($container->get('knp_snappy.image')->getOutputFromHtml('<h1>Bundle</h1>'), 'image.jpg');
$check('knp_snappy.image in a JpegResponse', strncmp($image->getContent(), "\xFF\xD8\xFF", 3) === 0);

(new Filesystem())->remove([$kernel->getCacheDir(), $kernel->getLogDir(), $config]);
exit($failures ? 1 : 0);
