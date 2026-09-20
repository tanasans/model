<?php
declare(strict_types=1);

/**
 * 予約枠の生成と空き判定。
 * 枠の長さ・時刻は config の booking.slot_minutes / booking.start_times だけで決まるので、
 * 30分枠などへの変更は設定ファイルの書き換えで済む。
 */
final class Slots
{
    /** 指定日の枠一覧（空き状況付き）を返す。 */
    public static function forDate(string $date): array
    {
        $d = self::parseDate($date);
        if (!$d) return [];

        $slotMin  = (int)config('booking.slot_minutes', 60);
        $starts   = (array)config('booking.start_times', []);
        $openDays = (array)config('booking.open_days', [0,1,2,3,4,5,6]);

        $closedDay = !in_array((int)$d->format('w'), array_map('intval', $openDays), true);

        $taken   = self::takenTimes($date);
        $blocks  = self::blocksFor($date);
        $allDayBlock = false;
        foreach ($blocks as $b) {
            if ($b['start_time'] === null) { $allDayBlock = true; break; }
        }

        $now       = new DateTimeImmutable('now');
        $leadLimit = $now->modify('+' . (int)config('booking.lead_hours', 3) . ' hours');
        $horizon   = $now->modify('+' . (int)config('booking.horizon_days', 30) . ' days')->setTime(23, 59, 59);

        $out = [];
        foreach ($starts as $start) {
            $startAt = self::at($date, (string)$start);
            if (!$startAt) continue;
            $endAt = $startAt->modify('+' . $slotMin . ' minutes');

            $reason = null;
            if ($closedDay || $allDayBlock)             $reason = 'closed';
            elseif (in_array((string)$start, $taken, true)) $reason = 'booked';
            elseif (self::overlapsBlock($startAt, $endAt, $blocks)) $reason = 'blocked';
            elseif ($startAt < $leadLimit)              $reason = 'too_soon';
            elseif ($startAt > $horizon)                $reason = 'too_far';

            $out[] = [
                'date'       => $date,
                'start_time' => $startAt->format('H:i'),
                'end_time'   => $endAt->format('H:i'),
                'available'  => $reason === null,
                'reason'     => $reason,
            ];
        }
        return $out;
    }

    /** 期間分の枠をまとめて返す（カレンダー表示用）。 */
    public static function forRange(string $from, int $days): array
    {
        $start = self::parseDate($from);
        if (!$start) return [];
        $days  = max(1, min(62, $days));
        $result = [];
        for ($i = 0; $i < $days; $i++) {
            $date = $start->modify("+{$i} days")->format('Y-m-d');
            $slots = self::forDate($date);
            $result[] = [
                'date'      => $date,
                'weekday'   => ['日','月','火','水','木','金','土'][(int)(new DateTimeImmutable($date))->format('w')],
                'slots'     => $slots,
                'open_count'=> count(array_filter($slots, fn($s) => $s['available'])),
            ];
        }
        return $result;
    }

    /** その枠が今この瞬間に予約可能かを判定する（送信時の最終チェック）。 */
    public static function validate(string $date, string $startTime): array
    {
        foreach (self::forDate($date) as $slot) {
            if ($slot['start_time'] === $startTime) {
                if ($slot['available']) return ['ok' => true, 'slot' => $slot];
                return ['ok' => false, 'reason' => $slot['reason'], 'message' => self::reasonText($slot['reason'])];
            }
        }
        return ['ok' => false, 'reason' => 'invalid', 'message' => 'ご指定の時間は見学枠として設けておりません。'];
    }

    public static function reasonText(?string $reason): string
    {
        return match ($reason) {
            'booked'   => 'その時間はすでに他のお客様のご予約が入っております。',
            'blocked'  => 'その時間は都合により見学を承っておりません。',
            'closed'   => 'その日は休業日のため見学を承っておりません。',
            'too_soon' => '直前のご予約は承れません。' . (int)config('booking.lead_hours', 3) . '時間以上先の時間をお選びください。',
            'too_far'  => 'ご予約は' . (int)config('booking.horizon_days', 30) . '日先までとなります。',
            default    => 'ご指定の時間はご予約いただけません。',
        };
    }

    /** 次に空いている枠を n 件返す（エラー時の代替案内用）。 */
    public static function nextAvailable(string $fromDate, int $limit = 6): array
    {
        $out  = [];
        $days = (int)config('booking.horizon_days', 30);
        $base = self::parseDate($fromDate) ?: new DateTimeImmutable('today');
        for ($i = 0; $i <= $days && count($out) < $limit; $i++) {
            foreach (self::forDate($base->modify("+{$i} days")->format('Y-m-d')) as $slot) {
                if ($slot['available']) {
                    $out[] = $slot;
                    if (count($out) >= $limit) break;
                }
            }
        }
        return $out;
    }

    private static function takenTimes(string $date): array
    {
        $st = Db::conn()->prepare("SELECT start_time FROM reservations WHERE date = ? AND status = 'confirmed'");
        $st->execute([$date]);
        return array_column($st->fetchAll(), 'start_time');
    }

    private static function blocksFor(string $date): array
    {
        $st = Db::conn()->prepare('SELECT start_time, end_time FROM blocks WHERE date = ?');
        $st->execute([$date]);
        return $st->fetchAll();
    }

    private static function overlapsBlock(DateTimeImmutable $s, DateTimeImmutable $e, array $blocks): bool
    {
        foreach ($blocks as $b) {
            if ($b['start_time'] === null || $b['end_time'] === null) continue;
            $bs = self::at($s->format('Y-m-d'), (string)$b['start_time']);
            $be = self::at($s->format('Y-m-d'), (string)$b['end_time']);
            if ($bs && $be && $s < $be && $bs < $e) return true;
        }
        return false;
    }

    public static function parseDate(string $date): ?DateTimeImmutable
    {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
        return ($d && $d->format('Y-m-d') === $date) ? $d : null;
    }

    public static function at(string $date, string $time): ?DateTimeImmutable
    {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d H:i', $date . ' ' . $time);
        return $d ?: null;
    }
}
