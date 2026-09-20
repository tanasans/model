<?php
/** 共通ブートストラップ。すべてのエントリポイントから最初に読み込む。 */

declare(strict_types=1);

mb_internal_encoding('UTF-8');
mb_language('uni');

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    http_response_code(500);
    exit('config.php がありません。config.sample.php をコピーして作成してください。');
}

/** @var array $CONFIG */
$CONFIG = require $configFile;

date_default_timezone_set($CONFIG['site']['timezone'] ?? 'Asia/Tokyo');

error_reporting(E_ALL);
ini_set('display_errors', $CONFIG['debug'] ? '1' : '0');
ini_set('log_errors', '1');
ini_set('error_log', rtrim($CONFIG['storage_dir'], '/') . '/php-error.log');

if (!is_dir($CONFIG['storage_dir'])) {
    mkdir($CONFIG['storage_dir'], 0700, true);
}

require_once __DIR__ . '/Db.php';
require_once __DIR__ . '/Logs.php';
require_once __DIR__ . '/Slots.php';
require_once __DIR__ . '/Reservations.php';
require_once __DIR__ . '/SwitchBot.php';
require_once __DIR__ . '/Mailer.php';
require_once __DIR__ . '/Sheets.php';
require_once __DIR__ . '/Outbox.php';

function config(?string $path = null, $default = null) {
    global $CONFIG;
    if ($path === null) return $CONFIG;
    $cur = $CONFIG;
    foreach (explode('.', $path) as $seg) {
        if (!is_array($cur) || !array_key_exists($seg, $cur)) return $default;
        $cur = $cur[$seg];
    }
    return $cur;
}

/** JSONで応答して終了する。 */
function json_out(array $data, int $status = 200): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function h(?string $s): string {
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}

/** 予約コード（お客様への案内・照会用）。紛らわしい文字は使わない。 */
function generate_code(): string {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $s = '';
    for ($i = 0; $i < 8; $i++) {
        $s .= $chars[random_int(0, strlen($chars) - 1)];
        if ($i === 3) $s .= '-';
    }
    return $s;
}

function client_ip(): string {
    return (string)($_SERVER['REMOTE_ADDR'] ?? '');
}
