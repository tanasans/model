<?php
declare(strict_types=1);

/** メール送信（さくらのサーバーの sendmail 経由）。 */
final class Mailer
{
    public static function send(string $to, string $subject, string $body): bool
    {
        $fromName = mb_encode_mimeheader((string)config('mail.from_name'), 'UTF-8');
        $from     = (string)config('mail.from');
        $headers  = [
            'From: ' . $fromName . ' <' . $from . '>',
            'Reply-To: ' . $from,
            'X-Mailer: modelroom-booking',
            'MIME-Version: 1.0',
        ];
        $envelope = (string)config('mail.envelope_from', $from);

        $ok = @mb_send_mail($to, $subject, $body, implode("\r\n", $headers), '-f' . $envelope);
        if (!$ok) {
            Logs::error('mail.failed', $to, '送信失敗: ' . $subject);
        }
        return (bool)$ok;
    }

    public static function toAdmins(string $subject, string $body): void
    {
        foreach ((array)config('mail.admin_to', []) as $addr) {
            self::send((string)$addr, $subject, $body);
        }
    }

    /** 予約確定＋パスコード通知。 */
    public static function reservationConfirmed(array $r): bool
    {
        $site = config('site');
        $bufB = (int)config('booking.buffer_before', 10);
        $bufA = (int)config('booking.buffer_after', 10);
        $validFrom = Slots::at($r['date'], $r['start_time'])->modify("-{$bufB} minutes")->format('H:i');
        $validTo   = Slots::at($r['date'], $r['end_time'])->modify("+{$bufA} minutes")->format('H:i');
        $dateLabel = self::dateLabel($r['date']);
        $cancelUrl = rtrim((string)$site['base_url'], '/') . '/cancel.php?code=' . rawurlencode($r['code']) . '&t=' . rawurlencode($r['cancel_token']);

        $subject = '【' . $site['name'] . '】ご見学の予約を承りました（' . $dateLabel . ' ' . $r['start_time'] . '〜）';

        $body = <<<TXT
{$r['name']} 様

この度は {$site['name']} のご見学をお申し込みいただき、誠にありがとうございます。
下記の内容でご予約を承りました。

──────────────────────────────
 ご予約番号 : {$r['code']}
 ご見学日時 : {$dateLabel} {$r['start_time']} 〜 {$r['end_time']}
 ご来場人数 : {$r['party_size']} 名様
 所在地     : {$site['address']}
──────────────────────────────

■ 入室用パスコード（{$r['passcode']}）

  玄関のキーパッドに次の番号を入力し、最後に丸ボタンを押してください。

        【 {$r['passcode']} 】

  ・このパスコードは {$dateLabel} {$validFrom} 〜 {$validTo} の間だけ有効です。
  ・この時間以外は番号を入力しても解錠できません。
  ・お連れ様以外への番号の共有はご遠慮ください。

■ ご見学の流れ
  1. ご予約時間にモデルルーム玄関までお越しください。
  2. 上記パスコードで解錠し、そのままご入室ください。
  3. ご見学後は照明を消し、扉を閉めてください。自動で施錠されます。

■ ご予約の変更・キャンセル
  こちらから承っております。
  {$cancelUrl}

ご不明な点は下記までお気軽にお問い合わせください。

{$site['company']}
{$site['name']}
TEL: {$site['tel']}
TXT;

        return self::send($r['email'], $subject, $body);
    }

    /** パスコード発行に失敗した場合のお客様向け案内。 */
    public static function passcodePending(array $r): bool
    {
        $site      = config('site');
        $dateLabel = self::dateLabel($r['date']);
        $subject   = '【' . $site['name'] . '】ご予約を承りました（入室方法は追ってご連絡いたします）';
        $body = <<<TXT
{$r['name']} 様

この度は {$site['name']} のご見学をお申し込みいただき、誠にありがとうございます。
下記の内容でご予約を承りました。

 ご予約番号 : {$r['code']}
 ご見学日時 : {$dateLabel} {$r['start_time']} 〜 {$r['end_time']}

入室用のパスコードにつきましては、ただいま準備をしております。
改めてメールにてお送りいたしますので、恐れ入りますがいましばらくお待ちください。
お急ぎの場合は下記までご連絡ください。

{$site['company']}
{$site['name']}
TEL: {$site['tel']}
TXT;
        return self::send($r['email'], $subject, $body);
    }

    /** キャンセル完了通知。 */
    public static function reservationCancelled(array $r): bool
    {
        $site      = config('site');
        $dateLabel = self::dateLabel($r['date']);
        $subject   = '【' . $site['name'] . '】ご予約をキャンセルいたしました';
        $body = <<<TXT
{$r['name']} 様

下記のご予約をキャンセルいたしました。
発行済みのパスコードは無効になっております。

 ご予約番号 : {$r['code']}
 ご見学日時 : {$dateLabel} {$r['start_time']} 〜 {$r['end_time']}

またのご利用をお待ちしております。

{$site['company']}
{$site['name']}
TEL: {$site['tel']}
TXT;
        return self::send($r['email'], $subject, $body);
    }

    /** 管理者向け：新規予約の通知。 */
    public static function adminNewReservation(array $r): void
    {
        $survey = json_decode((string)$r['survey_json'], true) ?: [];
        $lines  = [];
        foreach ((array)config('survey', []) as $q) {
            $v = $survey[$q['key']] ?? '';
            if ($v !== '') $lines[] = '  ' . $q['label'] . ': ' . $v;
        }
        $surveyText = $lines ? implode("\n", $lines) : '  （回答なし）';
        $keyState   = $r['key_status'] === 'issued' ? '発行済み' : '未発行（要確認）';

        self::toAdmins(
            '[予約] ' . $r['date'] . ' ' . $r['start_time'] . ' ' . $r['name'] . ' 様',
            <<<TXT
新しい見学予約が入りました。

 予約番号   : {$r['code']}
 日時       : {$r['date']} {$r['start_time']} 〜 {$r['end_time']}
 お名前     : {$r['name']}（{$r['kana']}）
 人数       : {$r['party_size']} 名
 メール     : {$r['email']}
 電話       : {$r['tel']}
 パスコード : {$r['passcode']} / 状態: {$keyState}

アンケート:
{$surveyText}
TXT
        );
    }

    public static function dateLabel(string $date): string
    {
        $d = new DateTimeImmutable($date);
        $w = ['日','月','火','水','木','金','土'][(int)$d->format('w')];
        return $d->format('Y年n月j日') . '（' . $w . '）';
    }
}
