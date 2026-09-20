<?php
declare(strict_types=1);

/** 予約の登録・キャンセル・鍵の発行／失効。 */
final class Reservations
{
    /**
     * 予約を作成する。
     * 二重予約は UNIQUE 制約で最終的に弾かれるので、同時送信があっても片方しか通らない。
     *
     * @param array $in name, kana, email, tel, date, start_time, party_size, survey
     * @return array{ok:bool, reservation?:array, error?:string, reason?:string, alternatives?:array}
     */
    public static function create(array $in): array
    {
        $check = Slots::validate((string)$in['date'], (string)$in['start_time']);
        if (!$check['ok']) {
            return [
                'ok'           => false,
                'reason'       => $check['reason'],
                'error'        => $check['message'],
                'alternatives' => Slots::nextAvailable((string)$in['date']),
            ];
        }
        $slot = $check['slot'];

        $now  = Db::now();
        $code = generate_code();
        $row  = [
            'code'         => $code,
            'status'       => 'confirmed',
            'date'         => $slot['date'],
            'start_time'   => $slot['start_time'],
            'end_time'     => $slot['end_time'],
            'name'         => (string)$in['name'],
            'kana'         => (string)($in['kana'] ?? ''),
            'email'        => (string)$in['email'],
            'tel'          => (string)($in['tel'] ?? ''),
            'party_size'   => (int)($in['party_size'] ?? 1),
            'survey_json'  => json_encode($in['survey'] ?? [], JSON_UNESCAPED_UNICODE),
            'cancel_token' => bin2hex(random_bytes(16)),
            'created_at'   => $now,
            'updated_at'   => $now,
            'ip'           => client_ip(),
            'ua'           => substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
        ];

        try {
            $cols = implode(',', array_keys($row));
            $ph   = implode(',', array_fill(0, count($row), '?'));
            Db::conn()->prepare("INSERT INTO reservations ($cols) VALUES ($ph)")
                ->execute(array_values($row));
        } catch (PDOException $e) {
            // UNIQUE 違反 = ほぼ同時に同じ枠が押さえられた
            if (str_contains($e->getMessage(), 'UNIQUE')) {
                Logs::warn('reservation.conflict', $slot['date'] . ' ' . $slot['start_time'], '同時予約により競合');
                return [
                    'ok'           => false,
                    'reason'       => 'booked',
                    'error'        => 'わずかな差で他のお客様のご予約が確定しました。別の時間をお選びください。',
                    'alternatives' => Slots::nextAvailable($slot['date']),
                ];
            }
            throw $e;
        }

        $reservation = self::findByCode($code);
        Logs::info('reservation.created', $code,
            $row['date'] . ' ' . $row['start_time'] . ' ' . $row['name'] . ' 様',
            ['email' => $row['email'], 'party_size' => $row['party_size']]);

        // 鍵のパスコードを発行 → お客様へメール
        $key = self::issueKey($reservation);
        $reservation = self::findByCode($code);

        if (!empty($key['ok'])) {
            if (Mailer::reservationConfirmed($reservation)) {
                self::touchMailSent($code);
            } else {
                Outbox::push('mail.confirmed', ['code' => $code]);
            }
        } else {
            // パスコードだけ失敗。予約は成立させ、発行とメールは後追いする。
            Mailer::passcodePending($reservation);
            Outbox::push('switchbot.issue', ['code' => $code]);
            Mailer::toAdmins(
                '[要対応] パスコード発行に失敗しました（' . $code . '）',
                "予約は成立していますが、SwitchBotのパスコード発行に失敗しました。\n"
                . "予約番号: {$code}\n日時: {$reservation['date']} {$reservation['start_time']}\n"
                . "エラー: " . (string)($key['error'] ?? '')
            );
        }

        Mailer::adminNewReservation($reservation);

        // スプレッドシートへの転記は失敗しても予約に影響させない
        if (Sheets::enabled()) {
            $sheetRes = Sheets::appendReservation($reservation);
            if (empty($sheetRes['ok'])) {
                Outbox::push('sheet.reservation.append', ['code' => $code]);
            }
        }

        return ['ok' => true, 'reservation' => $reservation];
    }

    /**
     * 予約時間帯だけ有効なパスコードを発行し、予約に紐付ける。
     * @param bool $retry 再送キューからの呼び出しか
     */
    public static function issueKey(array $r, bool $retry = false): array
    {
        $bufB = (int)config('booking.buffer_before', 10);
        $bufA = (int)config('booking.buffer_after', 10);
        $from = Slots::at($r['date'], $r['start_time'])->modify("-{$bufB} minutes");
        $to   = Slots::at($r['date'], $r['end_time'])->modify("+{$bufA} minutes");

        $res = SwitchBot::issuePasscode((string)$r['code'], $from, $to);

        if (!empty($res['ok'])) {
            Db::conn()->prepare(
                "UPDATE reservations SET passcode = ?, key_id = ?, key_status = 'issued', key_error = NULL, updated_at = ? WHERE code = ?"
            )->execute([$res['passcode'], (string)($res['key_id'] ?? ''), Db::now(), $r['code']]);

            if ($retry) {
                // 後追いで発行できた場合は、改めてパスコードをご案内する
                $fresh = self::findByCode((string)$r['code']);
                if ($fresh && Mailer::reservationConfirmed($fresh)) {
                    self::touchMailSent((string)$r['code']);
                }
            }
            return ['ok' => true];
        }

        Db::conn()->prepare(
            "UPDATE reservations SET key_status = 'failed', key_error = ?, updated_at = ? WHERE code = ?"
        )->execute([(string)($res['error'] ?? ''), Db::now(), $r['code']]);

        return ['ok' => false, 'error' => (string)($res['error'] ?? '')];
    }

    /** 予約をキャンセルし、発行済みパスコードを無効化する。 */
    public static function cancel(string $code, string $by = 'customer'): array
    {
        $r = self::findByCode($code);
        if (!$r)                          return ['ok' => false, 'error' => 'ご予約が見つかりません。'];
        if ($r['status'] === 'cancelled') return ['ok' => true, 'reservation' => $r, 'already' => true];

        Db::conn()->prepare("UPDATE reservations SET status = 'cancelled', updated_at = ? WHERE code = ?")
            ->execute([Db::now(), $code]);

        if (!empty($r['key_id'])) {
            $del = SwitchBot::deletePasscode($code, (string)$r['key_id']);
            if (empty($del['ok'])) {
                Outbox::push('switchbot.delete', ['code' => $code, 'key_id' => $r['key_id']]);
            }
            Db::conn()->prepare("UPDATE reservations SET key_status = 'revoked' WHERE code = ?")->execute([$code]);
        }

        Logs::info('reservation.cancelled', $code, 'キャンセル（' . $by . '）');

        $fresh = self::findByCode($code);
        Mailer::reservationCancelled($fresh);
        Mailer::toAdmins(
            '[キャンセル] ' . $fresh['date'] . ' ' . $fresh['start_time'] . ' ' . $fresh['name'] . ' 様',
            "ご予約がキャンセルされました（{$by}）。\n予約番号: {$code}\n日時: {$fresh['date']} {$fresh['start_time']}"
        );

        if (Sheets::enabled()) {
            $res = Sheets::updateReservation($fresh);
            if (empty($res['ok'])) Outbox::push('sheet.reservation.update', ['code' => $code]);
        }

        return ['ok' => true, 'reservation' => $fresh];
    }

    /** 終了した予約の後片付け（パスコード削除・状態更新）。cron から呼ぶ。 */
    public static function closeFinished(): int
    {
        $bufA  = (int)config('booking.buffer_after', 10);
        $limit = (new DateTimeImmutable("-{$bufA} minutes -5 minutes"));

        $st = Db::conn()->query(
            "SELECT * FROM reservations WHERE status = 'confirmed' AND datetime(date || ' ' || end_time) <= datetime('now','localtime')"
        );
        $n = 0;
        foreach ($st->fetchAll() as $r) {
            $end = Slots::at((string)$r['date'], (string)$r['end_time']);
            if (!$end || $end > $limit) continue;

            if (!empty($r['key_id']) && $r['key_status'] === 'issued') {
                $del = SwitchBot::deletePasscode((string)$r['code'], (string)$r['key_id']);
                if (empty($del['ok'])) {
                    Outbox::push('switchbot.delete', ['code' => $r['code'], 'key_id' => $r['key_id']]);
                }
            }
            Db::conn()->prepare("UPDATE reservations SET status = 'done', key_status = 'revoked', updated_at = ? WHERE code = ?")
                ->execute([Db::now(), $r['code']]);

            if (Sheets::enabled()) {
                Outbox::push('sheet.reservation.update', ['code' => $r['code']]);
            }
            Logs::info('reservation.closed', (string)$r['code'], '見学終了として締めました');
            $n++;
        }
        return $n;
    }

    public static function findByCode(string $code): ?array
    {
        $st = Db::conn()->prepare('SELECT * FROM reservations WHERE code = ?');
        $st->execute([$code]);
        return $st->fetch() ?: null;
    }

    private static function touchMailSent(string $code): void
    {
        Db::conn()->prepare('UPDATE reservations SET mail_sent_at = ? WHERE code = ?')
            ->execute([Db::now(), $code]);
    }

    /** 同じメールアドレスからの連続投稿を抑える（いたずら対策）。 */
    public static function recentCountByEmail(string $email, int $minutes = 10): int
    {
        $st = Db::conn()->prepare(
            "SELECT COUNT(*) AS c FROM reservations WHERE email = ? AND created_at >= datetime('now','localtime',?)"
        );
        $st->execute([$email, "-{$minutes} minutes"]);
        return (int)($st->fetch()['c'] ?? 0);
    }

    public static function recentCountByIp(string $ip, int $minutes = 10): int
    {
        $st = Db::conn()->prepare(
            "SELECT COUNT(*) AS c FROM reservations WHERE ip = ? AND created_at >= datetime('now','localtime',?)"
        );
        $st->execute([$ip, "-{$minutes} minutes"]);
        return (int)($st->fetch()['c'] ?? 0);
    }
}
