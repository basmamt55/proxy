<?php
declare(strict_types=1);

/**
 * Generates a Worker media URL with the real PHP helper, for integration tests.
 * Usage: php worker/test/php-token.php <upstream-url>
 */

$bootstrap = getenv('PHP_BOOTSTRAP') ?: '';
if ($bootstrap === '' || !is_file($bootstrap)) {
    $bootstrap = __DIR__ . '/../../bootstrap.php';
}
if (!is_file($bootstrap)) {
    $bootstrap = '/home/divhard-ex/htdocs/ex.divhard.com/bootstrap.php';
}
if (!is_file($bootstrap)) {
    echo "SKIP\n";
    exit(0);
}
require $bootstrap;
putenv('WORKER_PROXY_CONFIG_ONLY=1');
putenv('WORKER_PROXY_UNSIGNED=1');

$GLOBALS['DH_CONFIG']['worker_proxy'] = [
    'url' => 'http://proxy.test',
    'secret' => '',
    'ttl' => 300,
];

$target = $argv[1] ?? '';
if ($target === '') {
    fwrite(STDERR, "Usage: php worker/test/php-token.php <upstream-url> [referer] [kind]\n");
    exit(1);
}

$referer = $argv[2] ?? 'https://embed.example/watch';
$kind = $argv[3] ?? 'hls';
if (!in_array($kind, ['hls', 'file', 'text', 'img'], true)) {
    $kind = 'hls';
}

echo WorkerProxy::url($target, $referer, $kind), PHP_EOL;
