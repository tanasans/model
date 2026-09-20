<?php
/**
 * 定期実行（さくらのコントロールパネルのcronから5分おきに呼ぶ）。
 *   php /home/アカウント名/www/modelroom/bin/cron.php
 *
 * やること:
 *   1. 終了した見学のパスコード削除と締め処理
 *   2. 失敗した外部連携（パスコード発行・メール・シート転記）の再試行
 *   3. 未転記のログをスプレッドシートへ追記
 *   4. 翌日のご予約のリマインドメール
 */
require __DIR__ . '/../app/bootstrap.php';

if (PHP_SAPI !== 'cli') { http_response_code(403); exit('CLI専用です'); }

$started = microtime(true);
$report  = [];

/* 1. 終了分の締め */
try {
    $report['closed'] = Reservations::closeFinished();
} catch (Throwable $e) {
    Logs::error('cron.close_failed', '', $e->getMessage());
}

/* 2. 再送キュー */
try {
    $report['outbox'] = Outbox::process(30);
} catch (Throwable $e) {
    Logs::error('cron.outbox_failed', '', $e->getMessage());
}

/* 3. ログをスプレッドシートへ */
try {
    if (Sheets::enabled()) {
        $logs = Db::conn()->query('SELECT * FROM logs WHERE synced_at IS NULL ORDER BY id LIMIT 200')->fetchAll();
        if ($logs) {
            $res = Sheets::appendLogs($logs);
            if (!empty($res['ok'])) {
                $ids = implode(',', array_map('intval', array_column($logs, 'id')));
                Db::conn()->exec("UPDATE logs SET synced_at = '" . Db::now() . "' WHERE id IN ($ids)");
                $report['logs_synced'] = count($logs);
            } else {
                $report['logs_error'] = $res['error'] ?? '';
            }
        }
    }
} catch (Throwable $e) {
    error_log('cron logs sync: ' . $e->getMessage());
}

/* 4. 前日のリマインド（1日1回、朝の実行時だけ送る） */
try {
    if ((int)date('H') === 9 && (int)date('i') < 10) {
        $tomorrow = (new DateTimeImmutable('+1 day'))->format('Y-m-d');
        $st = Db::conn()->prepare("SELECT * FROM reservations WHERE date = ? AND status = 'confirmed'");
        $st->execute([$tomorrow]);
        $sent = 0;
        foreach ($st->fetchAll() as $r) {
            if ($r['key_status'] !== 'issued') continue;
            $ok = Mailer::send(
                (string)$r['email'],
                '【' . config('site.name') . '】明日のご見学のご案内',
                $r['name'] . " 様\n\n"
                . "明日 " . Mailer::dateLabel((string)$r['date']) . " {$r['start_time']}〜{$r['end_time']} に\n"
                . "ご見学のご予約をいただいております。\n\n"
                . "入室用パスコード： {$r['passcode']}\n"
                . "玄関のキーパッドにご入力ください。ご予約のお時間帯のみ有効です。\n\n"
                . config('site.address') . "\n"
                . config('site.company') . "　TEL: " . config('site.tel') . "\n"
            );
            if ($ok) $sent++;
        }
        $report['reminders'] = $sent;
        if ($sent) Logs::info('cron.reminder', $tomorrow, $sent . '件のリマインドを送信');
    }
} catch (Throwable $e) {
    Logs::error('cron.reminder_failed', '', $e->getMessage());
}

$report['elapsed'] = round(microtime(true) - $started, 2) . 's';
echo date('Y-m-d H:i:s') . ' ' . json_encode($report, JSON_UNESCAPED_UNICODE) . PHP_EOL;
