<?php
declare(strict_types=1);

/**
 * 外部サービス（スプレッドシート・SwitchBot・メール）への処理の再送キュー。
 * 予約そのものはDBに確定させ、外部連携が失敗しても後からcronで追いかける。
 */
final class Outbox
{
    /** 再送間隔（分）。試行回数に応じて広げる。 */
    private const BACKOFF = [1, 5, 15, 60, 180, 360];

    public static function push(string $kind, array $payload): void
    {
        $st = Db::conn()->prepare(
            'INSERT INTO outbox (kind, payload, next_try_at, created_at) VALUES (?,?,?,?)'
        );
        $st->execute([$kind, json_encode($payload, JSON_UNESCAPED_UNICODE), Db::now(), Db::now()]);
    }

    /** 未処理のジョブを順に実行する。cron から呼ぶ。 */
    public static function process(int $limit = 20): array
    {
        $st = Db::conn()->prepare(
            'SELECT * FROM outbox WHERE done_at IS NULL AND next_try_at <= ? ORDER BY id LIMIT ?'
        );
        $st->execute([Db::now(), $limit]);
        $jobs = $st->fetchAll();

        $done = 0; $failed = 0;
        foreach ($jobs as $job) {
            $payload = json_decode((string)$job['payload'], true) ?: [];
            try {
                $res = self::run((string)$job['kind'], $payload);
            } catch (Throwable $e) {
                $res = ['ok' => false, 'error' => $e->getMessage()];
            }

            if (!empty($res['ok'])) {
                Db::conn()->prepare('UPDATE outbox SET done_at = ?, last_error = NULL WHERE id = ?')
                    ->execute([Db::now(), $job['id']]);
                $done++;
            } else {
                $attempts = (int)$job['attempts'] + 1;
                $wait     = self::BACKOFF[min($attempts - 1, count(self::BACKOFF) - 1)];
                $next     = (new DateTimeImmutable("+{$wait} minutes"))->format('Y-m-d H:i:s');
                Db::conn()->prepare('UPDATE outbox SET attempts = ?, next_try_at = ?, last_error = ? WHERE id = ?')
                    ->execute([$attempts, $next, (string)($res['error'] ?? '不明なエラー'), $job['id']]);
                $failed++;

                if ($attempts === 3) {
                    Logs::error('outbox.stuck', (string)$job['kind'],
                        '3回失敗しました: ' . (string)($res['error'] ?? ''), $payload);
                    Mailer::toAdmins(
                        '[要確認] 連携処理が繰り返し失敗しています',
                        "種別: {$job['kind']}\n内容: {$job['payload']}\nエラー: " . (string)($res['error'] ?? '')
                    );
                }
            }
        }
        return ['done' => $done, 'failed' => $failed, 'picked' => count($jobs)];
    }

    private static function run(string $kind, array $payload): array
    {
        switch ($kind) {
            case 'sheet.reservation.append':
                $r = Reservations::findByCode((string)($payload['code'] ?? ''));
                return $r ? Sheets::appendReservation($r) : ['ok' => true];

            case 'sheet.reservation.update':
                $r = Reservations::findByCode((string)($payload['code'] ?? ''));
                return $r ? Sheets::updateReservation($r) : ['ok' => true];

            case 'switchbot.issue':
                $r = Reservations::findByCode((string)($payload['code'] ?? ''));
                if (!$r || $r['status'] !== 'confirmed' || $r['key_status'] === 'issued') return ['ok' => true];
                return Reservations::issueKey($r, true);

            case 'switchbot.delete':
                return SwitchBot::deletePasscode(
                    (string)($payload['code'] ?? ''),
                    (string)($payload['key_id'] ?? '')
                );

            case 'mail.confirmed':
                $r = Reservations::findByCode((string)($payload['code'] ?? ''));
                if (!$r) return ['ok' => true];
                return ['ok' => Mailer::reservationConfirmed($r)];

            default:
                return ['ok' => true];
        }
    }
}
