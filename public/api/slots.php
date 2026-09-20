<?php
/**
 * 空き枠の照会。
 *   /api/slots.php?from=2026-09-21&days=14
 */
require __DIR__ . '/../../app/bootstrap.php';

$from = (string)($_GET['from'] ?? date('Y-m-d'));
$days = (int)($_GET['days'] ?? 14);

if (!Slots::parseDate($from)) {
    json_out(['ok' => false, 'error' => '日付の形式が正しくありません。'], 400);
}

// 過去の日付は今日に寄せる
if ($from < date('Y-m-d')) $from = date('Y-m-d');

json_out([
    'ok'    => true,
    'today' => date('Y-m-d'),
    'days'  => Slots::forRange($from, $days),
]);
